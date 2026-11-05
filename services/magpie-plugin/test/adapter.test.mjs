import test from 'node:test';
import assert from 'node:assert/strict';
import { startAdapter } from '../src/adapter.mjs';
import { COMPATIBLE_DSH, foldLifecycle, initialLifecycle, normalizedTurn, normalizeUsage } from '../src/projection.mjs';

const config = { sourceId: 'test-source', bridgeUrl: 'http://127.0.0.1:7445', ipcTokenEnv: 'TEST_IPC',
  sourceTokenEnv: 'TEST_SOURCE', sessionIds: ['selected'], includeAllSessions: false };
const env = { TEST_IPC: 'a'.repeat(40), TEST_SOURCE: 'b'.repeat(40) };
function fixture() {
  const session = { id: 'selected', seq: 1, header: { isSeeded: false }, inheritedEventCount: 0 };
  const agent = { session, status: 'running' };
  let lifecycle = { turn: 1, startSeq: 0, ended: false };
  let usage = { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
  let questionView = { active: [] };
  const listeners = new Map(); const sent = []; const effects = [];
  let closed = false; let disposed = false; let fail = false;
  const ctx = {
    sessions: { get: (id) => id === session.id ? session : undefined, list: () => [session] },
    agents: { get: () => agent }, logger: { warn() {} }, effect: (effect) => effects.push(effect()),
    sessionProjections: {
      register: async () => ({ stateOf: () => lifecycle, dispose: async () => { disposed = true; } }),
      snapshot: () => ({ asOfSeq: session.seq - 1, values: { tokenUsage: usage, userQuestions: questionView } }),
      onChanged: (listener) => { listeners.set('projection', listener); return () => listeners.delete('projection'); },
    },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
  };
  const options = { version: COMPATIBLE_DSH, lifecycleDefinition: {}, env,
    transportFactory: () => ({ post: async (path, body) => { if (fail) throw new Error('private failure contents'); sent.push({ path, body: structuredClone(body) }); },
      close: () => { closed = true; } }) };
  return { session, agent, ctx, sent, listeners, options, effects, setLifecycle: (v) => { lifecycle = v; },
    setUsage: (v) => { usage = v; }, setQuestions: (v) => { questionView = v; },
    setFail: (v) => { fail = v; }, get closed() { return closed; }, get disposed() { return disposed; } };
}

test('turn end is distinct from goal completion and next turn has distinct identity', () => {
  const start = foldLifecycle(initialLifecycle(), { type: 'turn/start', seq: 2, data: { turn: 1 } });
  const ended = foldLifecycle(start, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } });
  const f = fixture();
  const args = { sourceId: 'test', session: f.session, agent: f.agent, snapshot: { asOfSeq: 3, values: {} }, live: new Map(), revision: 1 };
  const event = normalizedTurn({ ...args, lifecycle: ended });
  assert.equal(event.turn_outcome, 'ended'); assert.equal(event.task_outcome, null);
  assert.equal(event.execution_state, 'running');
  const second = foldLifecycle(ended, { type: 'turn/start', seq: 4, data: { turn: 2 } });
  assert.notEqual(normalizedTurn({ ...args, lifecycle: second }).run_id, event.run_id);
  assert.equal(foldLifecycle(second, { type: 'tool/result', data: { isError: true } }), second);
});

test('usage exports authoritative whole totals and rejects unsafe counters and inherited forks', () => {
  const f = fixture(); const snapshot = f.ctx.sessionProjections.snapshot();
  assert.equal(normalizeUsage(snapshot, f.session).input_tokens, '10');
  assert.equal(normalizeUsage(snapshot, { ...f.session, header: { isSeeded: true } }), undefined);
  assert.equal(normalizeUsage(snapshot, { ...f.session, inheritedEventCount: 5 }), undefined);
  snapshot.values.tokenUsage.outputTokens = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => normalizeUsage(snapshot, f.session), /invalid_token_counter/);
});

test('real source configuration gates version, scope and credentials before any network effect', async () => {
  const f = fixture(); let opened = false;
  const options = { ...f.options, transportFactory: () => { opened = true; } };
  await assert.rejects(startAdapter(f.ctx, config, { ...options, version: '0.2.3' }), /unsupported_dsh_version/);
  await assert.rejects(startAdapter(f.ctx, { ...config, bridgeUrl: 'http://example.com/' }, options), /literal_loopback/);
  await assert.rejects(startAdapter(f.ctx, config, { ...options, env: {} }), /missing_adapter_credential/);
  assert.equal(opened, false);
});

test('blocking question observer delegates exact answer, maintains running, and clears after resolution', async () => {
  const f = fixture(); const adapter = await startAdapter(f.ctx, config, f.options);
  let resolve; const answer = { answers: [{ id: 'question', selected: [] }] };
  const promise = new Promise((r) => { resolve = r; }); let called = 0;
  const result = f.listeners.get('user-questions/request')({ agent: f.agent, questions: [{ question: 'PRIVATE TEXT' }] }, () => { called++; return promise; });
  await adapter.flush();
  const event = f.sent.filter((v) => v.path === '/v1/events').at(-1).body.event;
  assert.equal(called, 1); assert.equal(event.execution_state, 'running');
  assert.equal(event.pending_interactions[0].blocks_execution, true);
  assert.ok(!JSON.stringify(f.sent).includes('PRIVATE TEXT'));
  resolve(answer); assert.equal(await result, answer);
  await adapter.flush();
  assert.deepEqual(f.sent.filter((v) => v.path === '/v1/events').at(-1).body.event.pending_interactions, []);
  await adapter.stop(); assert.equal(f.closed, true); assert.equal(f.disposed, true); assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.sent.at(-1), { path: '/v1/source/heartbeat', body: { connected: false } });
});

test('timed continued question deduplicates call ID and forwards answerer rejection unchanged', async () => {
  const f = fixture(); const adapter = await startAdapter(f.ctx, config, f.options);
  f.setQuestions({ active: [{ callId: 'call-1', state: 'continued' }] });
  const error = new Error('original answerer error');
  const run = f.listeners.get('user-questions/request')({ agent: f.agent, wait: { callId: 'call-1', timed: true } }, () => Promise.reject(error));
  await assert.rejects(run, (value) => value === error);
  await adapter.flush();
  const pending = f.sent.filter((v) => v.path === '/v1/events').at(-1).body.event.pending_interactions;
  assert.equal(pending.length, 1); assert.equal(pending[0].request_id, 'call-1'); assert.equal(pending[0].blocks_execution, false);
  await adapter.stop();
});

test('registry disposal marks execution unknown and clears dead questions without inventing an outcome', async () => {
  const f = fixture(); const adapter = await startAdapter(f.ctx, config, f.options);
  await adapter.flush();
  f.listeners.get('session/disposed')(f.session);
  await adapter.flush();
  const event = f.sent.filter((value) => value.path === '/v1/events').at(-1).body.event;
  assert.equal(event.execution_state, 'unknown');
  assert.deepEqual(event.pending_interactions, []);
  assert.equal(event.task_outcome, null);
  await adapter.stop();
});

test('unload drains earlier heartbeat before publishing disconnect', async () => {
  const f = fixture(); let finishFirst;
  const sent = [];
  const transportFactory = () => ({
    post: (path, body) => { sent.push({ path, body });
      if (body.connected === true) return new Promise((resolve) => { finishFirst = resolve; });
      return Promise.resolve(); }, close() {},
  });
  const adapter = await startAdapter(f.ctx, config, { ...f.options, transportFactory });
  const stopped = adapter.stop();
  assert.equal(sent.at(-1).body.connected, true);
  finishFirst(); await stopped;
  assert.equal(sent.at(-1).body.connected, false);
});

test('unselected sessions and wrong live instance never export; retry retains newest corrected total', async () => {
  const f = fixture(); const adapter = await startAdapter(f.ctx, config, f.options);
  await adapter.flush(); f.sent.length = 0;
  f.listeners.get('session/event')({ ...f.session }, { type: 'turn/end' });
  await adapter.flush(); assert.equal(f.sent.length, 0);
  f.setFail(true); f.session.seq++;
  f.listeners.get('session/event')(f.session, { type: 'assistant/message' });
  await adapter.flush(); assert.equal(f.sent.length, 0);
  f.setUsage({ uncachedInputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
  f.session.seq++; f.listeners.get('projection')(f.session, 'tokenUsage');
  f.setFail(false); await adapter.flush();
  assert.equal(f.sent.at(-1).body.event.usage.input_tokens, '7');
  assert.equal(f.sent.at(-1).body.event.usage.revision, 3);
  await adapter.stop();
});
