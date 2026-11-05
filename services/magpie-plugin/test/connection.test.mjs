import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { resolveConnection } from '../src/connection.mjs';
const prefix = fileURLToPath(new URL('../.test-connection-', import.meta.url));
const settings = { sourceId: 'fallback', bridgeUrl: 'http://127.0.0.1:7445', ipcTokenEnv: 'TEST_IPC', sourceTokenEnv: 'TEST_SOURCE', sessionIds: [], includeAllSessions: true };
async function fixture(t) {
  const directory = await mkdtemp(prefix);
  t.after(async () => { assert.ok(directory.startsWith(prefix)); await rm(directory, { recursive: true, force: true }); });
  const filename = join(directory, 'connection.json');
  const value = { sourceId: 'synthetic', bridgeUrl: 'http://127.0.0.1:12345', ipcToken: 'a'.repeat(40), sourceToken: 'b'.repeat(40), sessionIds: ['synthetic-session'] };
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  return { directory, filename, value };
}
test('secure explicit connection file activates exact allowlist without environment changes', async (t) => {
  const f = await fixture(t);
  const result = await resolveConnection({ ...settings, connectionFile: f.filename }, { env: {} });
  assert.equal(result.settings.sourceId, 'synthetic');
  assert.deepEqual(result.settings.sessionIds, ['synthetic-session']);
  assert.equal(result.settings.includeAllSessions, false);
  assert.equal(result.env.TEST_IPC, f.value.ipcToken);
  assert.equal(result.settings.ipcToken, undefined);
  const overridden = await resolveConnection({ ...settings, connectionFile: f.filename }, { env: { TEST_IPC: 'x'.repeat(40) } });
  assert.equal(overridden.env.TEST_IPC, 'x'.repeat(40));
});
test('connection file rejects permissions, symlink, wrong owner and unknown fields', async (t) => {
  const f = await fixture(t);
  const config = { ...settings, connectionFile: f.filename };
  await chmod(f.filename, 0o644);
  await assert.rejects(resolveConnection(config, { env: {} }), /unsafe_connection_file/);
  await chmod(f.filename, 0o600);
  await assert.rejects(resolveConnection(config, { env: {}, uid: process.getuid() + 1 }), /unsafe_connection_file/);
  const alias = join(f.directory, 'alias.json'); await symlink(f.filename, alias);
  await assert.rejects(resolveConnection({ ...settings, connectionFile: alias }, { env: {} }), /unsafe_connection_file/);
  await writeFile(f.filename, JSON.stringify({ ...f.value, includeAllSessions: true }));
  await assert.rejects(resolveConnection(config, { env: {} }), /invalid_connection_file/);
});
test('missing file and no credentials remains inactive; explicit environment still works', async (t) => {
  const f = await fixture(t); const absent = join(f.directory, 'absent.json');
  assert.equal(await resolveConnection({ ...settings, connectionFile: absent }, { env: {} }), null);
  const configured = await resolveConnection({ ...settings, connectionFile: absent }, { env: { TEST_IPC: 'x'.repeat(40), TEST_SOURCE: 'y'.repeat(40) } });
  assert.equal(configured.env.TEST_SOURCE, 'y'.repeat(40));
});
