import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTransport, validateBridgeUrl } from '../src/transport.mjs';

test('literal authenticated loopback IPC omits browser Origin and refuses redirects', async (t) => {
  let status = 204; let received;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { headers: req.headers, body: JSON.parse(body), path: req.url };
    res.writeHead(status, status === 302 ? { location: 'http://example.com/' } : {}); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const transport = createTransport({ bridgeUrl: `http://127.0.0.1:${server.address().port}`,
    ipcToken: 'test-ipc', sourceToken: 'test-source' });
  t.after(() => transport.close());
  await transport.post('/v1/events', { event: { source_id: 'test' } });
  assert.equal(received.headers.authorization, 'Bearer test-ipc'); assert.equal(received.headers.origin, undefined);
  assert.equal(received.body.source_credential, 'test-source'); assert.equal(received.path, '/v1/events');
  status = 302;
  await assert.rejects(transport.post('/v1/events', { event: {} }), /ipc_rejected/);
  await assert.rejects(transport.post('/v1/private', {}), /unsupported_ipc_route/);
  transport.close(); await assert.rejects(transport.post('/v1/events', {}), /transport_closed/);
});

test('IPC blocks remote URLs, DNS, embedded auth, fragments and unexpected paths', () => {
  for (const url of ['http://localhost:7445', 'http://192.168.0.1:7445', 'https://127.0.0.1:7445',
    'http://user:secret@127.0.0.1:7445', 'http://127.0.0.1:7445?secret=x', 'http://127.0.0.1:7445/extra', 'http://127.0.0.1:7445#secret']) {
    assert.throws(() => validateBridgeUrl(url));
  }
});
