import test from 'node:test';
import assert from 'node:assert/strict';
import { Model } from '../../src/model.mjs';
import { startAdapter } from '../src/adapter.mjs';
import { COMPATIBLE_DSH } from '../src/projection.mjs';
const config = { sourceId: 'test-source', bridgeUrl: 'http://127.0.0.1:7445', ipcTokenEnv: 'TEST_IPC', sourceTokenEnv: 'TEST_SOURCE', sessionIds: ['selected'], includeAllSessions: false };
function fixture() {
  let model = new Model(); let present = true; let usageFailure = false; let lifecycleFailure = false;
  const session = { id: 'selected', seq: 3, header: { isSeeded: false }, inheritedEventCount: 0 };
  const agent = { session, status: 'running' }; const sent = [];
  const ctx = { sessions: { get: (id) => present && id === session.id ? session : undefined, list: () => present ? [session] : [] },
    agents: { get: () => agent }, logger: { warn() {} }, effect() {}, on: () => () => {},
    sessionProjections: { register: async () => ({ stateOf: () => { if (lifecycleFailure) throw new Error('PRIVATE LIFECYCLE TEXT'); return { turn: 1, startSeq: 0, ended: false }; }, dispose: async () => {} }),
      snapshot: (s, keys) => { if (usageFailure && keys.includes('tokenUsage')) throw new Error('PRIVATE USAGE TEXT');
        return { asOfSeq: 2, values: { tokenUsage: { uncachedInputTokens: 12, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 8 }, userQuestions: { active: [] } } }; },
      onChanged: () => () => {},
    } };
  const options = { version: COMPATIBLE_DSH, lifecycleDefinition: {}, env: { TEST_IPC: 'a'.repeat(40), TEST_SOURCE: 'b'.repeat(40) },
    transportFactory: () => ({ post: async (path, body) => { sent.push({ path, body }); if (path === '/v1/events') model.ingest(body.event); }, close() {} }) };
  return { ctx, options, sent, get model() { return model; }, restart: () => { model = new Model(); },
    setPresent: (value) => { present = value; }, setUsageFailure: (value) => { usageFailure = value; }, setLifecycleFailure: (value) => { lifecycleFailure = value; } };
}
test('empty restarted bridge is repopulated without any new host event or log revision', async () => {
  const f = fixture(); const adapter = await startAdapter(f.ctx, config, f.options);
  await adapter.reconcile(); await adapter.flush();
  assert.equal(f.model.tasks.size, 1);
  const first = [...f.model.tasks.values()][0];
  f.restart(); assert.equal(f.model.tasks.size, 0);
  await adapter.reconcile(); await adapter.flush();
  assert.equal(f.model.tasks.size, 1);
  const recovered = [...f.model.tasks.values()][0];
  assert.equal(recovered.execution_state, 'running');
  assert.ok(recovered.state_revision > first.state_revision);
  assert.equal(f.sent.filter((value) => value.path === '/v1/events').at(-1).body.event.usage.revision, 3);
  await adapter.stop();
});
test('optional usage projection failure does not suppress selected current lifecycle', async () => {
  const f = fixture(); f.setUsageFailure(true);
  const adapter = await startAdapter(f.ctx, config, f.options);
  await adapter.reconcile(); await adapter.flush();
  assert.equal(f.model.tasks.size, 1);
  const event = f.sent.filter((value) => value.path === '/v1/events').at(-1).body.event;
  assert.equal(event.execution_state, 'running'); assert.equal(event.run_id, 'turn-1-0'); assert.equal(event.usage, undefined);
  const counts = adapter.diagnostics(); assert.equal(counts.selected_live, 1); assert.ok(counts.usage_failures > 0);
  assert.equal(counts.last_failure_stage, 'token_usage'); assert.ok(!JSON.stringify(counts).includes('PRIVATE'));
  await adapter.stop();
});
test('unavailable lifecycle yields an honest live observation with no inferred outcome', async () => {
  const f = fixture(); f.setLifecycleFailure(true);
  const adapter = await startAdapter(f.ctx, config, f.options);
  await adapter.reconcile(); await adapter.flush();
  const event = f.sent.filter((value) => value.path === '/v1/events').at(-1).body.event;
  assert.equal(event.run_id, 'session-observed'); assert.equal(event.execution_state, 'running');
  assert.equal(event.turn_outcome, null); assert.equal(event.task_outcome, null);
  assert.ok(adapter.diagnostics().lifecycle_failures > 0);
  await adapter.stop();
});
test('selected session loaded after activation republishes on reconciliation without broadening scope', async () => {
  const f = fixture(); f.setPresent(false);
  const adapter = await startAdapter(f.ctx, config, f.options);
  await adapter.reconcile();
  assert.equal(adapter.diagnostics().selected_configured, 1); assert.equal(adapter.diagnostics().selected_live, 0);
  assert.equal(f.model.tasks.size, 0);
  f.setPresent(true); await adapter.reconcile(); await adapter.flush();
  assert.equal(adapter.diagnostics().selected_live, 1); assert.equal(f.model.tasks.size, 1);
  await adapter.stop();
});
