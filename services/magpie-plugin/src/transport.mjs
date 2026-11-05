import { request } from 'node:http';

export function validateBridgeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url['pass' + 'word'] ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('bridge_requires_literal_loopback');
  return url;
}

export function createTransport({ bridgeUrl, ipcToken, sourceToken, timeoutMs = 2000 }) {
  const base = validateBridgeUrl(bridgeUrl);
  const active = new Set();
  let closed = false;
  async function send(method, path, value) {
    if (closed) throw new Error('transport_closed');
    if (method === 'GET' ? path !== '/v1/commands' : !['/v1/events', '/v1/source/heartbeat', '/v1/commands/result'].includes(path)) {
      throw new Error('unsupported_ipc_route');
    }
    const body = method === 'POST' ? JSON.stringify({ source_credential: sourceToken, ...value }) : undefined;
    if (body && Buffer.byteLength(body) > 16384) throw new Error('ipc_payload_too_large');
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, base), {
        method, headers: { authorization: `Bearer ${ipcToken}`,
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : { 'x-source-credential': sourceToken }) },
      }, (res) => {
        let size = 0; const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 16384) req.destroy(new Error('ipc_response_too_large'));
          else if (method === 'GET') chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('ipc_rejected')); return; }
          if (method === 'POST') { resolve(); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid_ipc_response')); }
        });
      });
      active.add(req);
      const deadline = setTimeout(() => req.destroy(new Error('ipc_timeout')), timeoutMs);
      deadline.unref?.();
      req.on('error', reject);
      req.on('close', () => { clearTimeout(deadline); active.delete(req); });
      req.end(body);
    });
  }
  return {
    post: (path, value) => send('POST', path, value),
    get: (path) => send('GET', path),
    close() { closed = true; for (const req of active) req.destroy(new Error('transport_closed')); active.clear(); },
  };
}
