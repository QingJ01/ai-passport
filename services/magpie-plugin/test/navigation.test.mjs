import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationRelay } from '../src/navigation.mjs';
import { startCompanion } from '../src/client-core.mjs';
const command = { command_id: 'command-1', type: 'open_on_host', session_id: 'selected' };
const tick = () => new Promise(setImmediate);

test('host leases one companion and never reassigns an intent after client loss', async () => {
  let clock = 100; const capabilities = []; const results = [];
  const relay = createNavigationRelay({ now: () => clock, get: async () => ({ commands: [command] }),
    post: async (path, body) => { results.push(body); }, allowed: (id) => id === 'selected', onAvailability: (value) => capabilities.push(value) });
  assert.equal(relay.available(), false);
  assert.deepEqual((await relay.poll('client-1')).commands, [command]);
  assert.deepEqual((await relay.poll('client-2')).commands, []);
  clock += 6000;
  assert.deepEqual((await relay.poll('client-2')).commands, []);
  assert.equal(await relay.result('client-1', command.command_id, 'succeeded'), true);
  assert.equal(await relay.result('client-1', command.command_id, 'succeeded'), true);
  assert.equal(results.length, 1);
  await assert.rejects(relay.result('client-2', command.command_id, 'succeeded'), /unassigned/);
  await assert.rejects(relay.result('client-1', command.command_id, 'failed'), /conflicting/);
  relay.leave('client-2'); assert.equal(relay.available(), false); relay.close();
  assert.deepEqual(capabilities, [true, true, false]);
});
test('host filters unselected targets and retries result delivery without redispatching', async () => {
  let failure = true; const results = [];
  const relay = createNavigationRelay({ get: async () => ({ commands: [command] }), allowed: () => false, onAvailability() {},
    post: async (path, value) => { results.push(value); if (failure) throw new Error('offline'); } });
  assert.deepEqual((await relay.poll('client')).commands, []);
  failure = false;
  assert.deepEqual((await relay.poll('client')).commands, []);
  assert.equal(results.length, 2); assert.equal(results[0].status, 'failed'); relay.close();
});
test('client invokes openSession once and reports success only after selected session matches', async () => {
  let opens = 0; let selection = {}; let failedAck = true; const results = [];
  const ctx = { uiWorkspace: { openSession: (id) => { opens++; selection = { sessionId: id }; }, selection: { getSnapshot: () => selection } } };
  const remote = { poll: async () => ({ ok: true, value: { commands: [command] } }), leave: async () => ({ ok: true, value: true }),
    result: async (clientId, commandId, status) => { results.push(status); if (failedAck) throw new Error('lost response'); return { ok: true, value: true }; } };
  const client = startCompanion(ctx, { remote, clientId: 'client', visible: () => true, setTimer: () => 1, clearTimer() {} });
  await tick(); assert.equal(opens, 1); assert.equal(results[0], 'succeeded');
  failedAck = false; await client.poll(); assert.equal(opens, 1); assert.equal(results.at(-1), 'succeeded');
  client.stop();
});
test('unconfirmed selection and navigation failure never report success; hidden page does not navigate', async () => {
  for (const mode of ['unconfirmed', 'throw', 'hidden']) {
    let opens = 0; const results = [];
    const ctx = { uiWorkspace: { openSession() { opens++; if (mode === 'throw') throw new Error('failure'); }, selection: { getSnapshot: () => ({}) } } };
    const remote = { poll: async () => ({ ok: true, value: { commands: [command] } }), leave: async () => ({ ok: true }),
      result: async (clientId, commandId, status) => { results.push(status); return { ok: true, value: true }; } };
    const client = startCompanion(ctx, { remote, clientId: 'client', visible: () => mode !== 'hidden', setTimer: () => 1, clearTimer() {} });
    await tick();
    assert.equal(opens, mode === 'hidden' ? 0 : 1);
    assert.deepEqual(results, mode === 'hidden' ? [] : [mode === 'throw' ? 'failed' : 'unknown']);
    client.stop();
  }
});
