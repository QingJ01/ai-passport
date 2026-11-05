import { open, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export async function resolveConnection(config, { env = process.env, uid = process.getuid?.(), home = homedir() } = {}) {
  const filename = config.connectionFile || join(home, '.config', 'agent-pet', 'magpie.json');
  if (!isAbsolute(filename) || uid === undefined) throw new Error('unsafe_connection_file');
  let file;
  let value;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) {
      throw new Error('unsafe_connection_file');
    }
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error('unsafe_connection_file');
    const content = buffer.toString('utf8', 0, bytesRead);
    try { value = JSON.parse(content); } catch { throw new Error('invalid_connection_file'); }
    const keys = ['bridgeUrl', 'sourceId', 'ipcToken', 'sourceToken', 'sessionIds'];
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key)) ||
      typeof value.bridgeUrl !== 'string' || typeof value.sourceId !== 'string' ||
      typeof value.ipcToken !== 'string' || typeof value.sourceToken !== 'string' ||
      !Array.isArray(value.sessionIds) || value.sessionIds.length === 0) throw new Error('invalid_connection_file');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Never expose file contents, source IDs or path-bearing OS exceptions to diagnostics.
      throw new Error(['unsafe_connection_file', 'invalid_connection_file'].includes(error.message) ? error.message : 'unsafe_connection_file');
    }
  } finally { await file?.close(); }
  const settings = { ...config };
  delete settings.connectionFile;
  if (value) Object.assign(settings, { bridgeUrl: value.bridgeUrl, sourceId: value.sourceId,
    sessionIds: value.sessionIds, includeAllSessions: false });
  const credentialEnv = { ...env };
  credentialEnv[settings.ipcTokenEnv] = env[settings.ipcTokenEnv] || value?.ipcToken;
  credentialEnv[settings.sourceTokenEnv] = env[settings.sourceTokenEnv] || value?.sourceToken;
  if (!value && !credentialEnv[settings.ipcTokenEnv] && !credentialEnv[settings.sourceTokenEnv]) return null;
  return { settings, env: credentialEnv };
}
