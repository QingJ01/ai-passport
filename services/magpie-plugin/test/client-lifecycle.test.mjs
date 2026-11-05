import test from 'node:test';
import assert from 'node:assert/strict';
import { startCompanion } from '../src/client-core.mjs';
const command = { command_id: 'command-1', type: 'open_on_host', session_id: 'selected' };
const tick = () => new Promise(setImmediate);

test('client rejects a poll response older than its host lease', async () => {
  let clock = 0; let resolvePoll; let opens = 0;
  const ctx = { uiWorkspace: { openSession() { opens++; }, selection: { getSnapshot: () => ({ sessionId: 'selected' }) } } };
  const remote = { poll: () => new Promise((resolve) => { resolvePoll = resolve; }), result: async () => ({ ok: true, value: true }), leave: async () => ({ ok: true }) };
  const companion = startCompanion(ctx, { remote, clientId: 'client', now: () => clock, visible: () => true, setTimer: () => 1, clearTimer() {} });
  clock = 6000; resolvePoll({ ok: true, value: { commands: [command] } }); await tick();
  assert.equal(opens, 0); companion.stop();
});

test('unload between intent results prevents subsequent navigation', async () => {
  let resolveResult; let opens = 0;
  const ctx = { uiWorkspace: { openSession() { opens++; }, selection: { getSnapshot: () => ({ sessionId: 'selected' }) } } };
  const remote = { poll: async () => ({ ok: true, value: { commands: [command, { ...command, command_id: 'command-2' }] } }),
    result: () => new Promise((resolve) => { resolveResult = resolve; }), leave: async () => ({ ok: true }) };
  const companion = startCompanion(ctx, { remote, clientId: 'client', visible: () => true, setTimer: () => 1, clearTimer() {} });
  await tick(); assert.equal(opens, 1); companion.stop();
  resolveResult({ ok: true, value: true }); await tick(); assert.equal(opens, 1);
});
