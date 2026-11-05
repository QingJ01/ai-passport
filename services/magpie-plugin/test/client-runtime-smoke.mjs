// Real host/client Typert gateways, real browser module factory, mocked UI surface.
// Runs only in an isolated process; never installs a profile or focuses a window.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { runInThisContext } from 'node:vm';
const runtime = process.env.DSH_TEST_RUNTIME;
if (!runtime) throw new Error('Set DSH_TEST_RUNTIME');
const requireRuntime = createRequire(pathToFileURL(`${runtime}/package.json`));
const root = new URL('..', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(root)) return nextResolve(pathToFileURL(requireRuntime.resolve(specifier)).href, context);
  return nextResolve(specifier, context);
} });
const load = (name) => import(pathToFileURL(`${runtime}/node_modules/@deepseek-ai/${name}/lib/index.js`).href);
const { Context } = await load('cordis');
const { default: Registry } = await load('dsh-typert-registry');
const { default: Projections } = await load('dsh-session-projection');
const { SessionStore } = await load('dsh-session');
const { AgentRegistry } = await load('dsh-agent');
const { default: TokenMeter } = await load('dsh-token-meter');
const { default: Questions } = await load('dsh-user-questions');
const { default: HostGateway } = await load('dsh-api-gateway');
const ClientGateway = await import(pathToFileURL(`${runtime}/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.node.js`).href);
const entry = await import('../src/index.mjs');
const command = { command_id: 'synthetic-command', type: 'open_on_host', session_id: 'synthetic' };
const received = [];
let finished = false;
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    assert.equal(req.headers['x-source-credential'], 'y'.repeat(40));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ commands: finished ? [] : [command] })); return;
  }
  let body = ''; for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body); received.push({ path: req.url, body: parsed });
  if (req.url === '/v1/commands/result') { assert.equal(parsed.status, 'succeeded'); finished = true; }
  res.writeHead(204); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const host = new Context(); const client = new Context();
const start = async (ctx, plugin) => { const fiber = ctx.plugin(plugin); await fiber.inertia; assert.equal(fiber.state, 2, plugin.name); return fiber; };
try {
  for (const plugin of [Registry, Projections, SessionStore, AgentRegistry, TokenMeter, Questions]) await start(host, plugin);
  host.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) });
  await start(host, HostGateway);
  process.env.ADAPTER_SMOKE_IPC = 'x'.repeat(40); process.env.ADAPTER_SMOKE_SOURCE = 'y'.repeat(40);
  const session = host.sessions.create('synthetic', { meta: {} });
  host.agents.enter({ id: 'synthetic', session, status: 'running', ctx: host });
  const adapter = host.plugin(entry, { sourceId: 'synthetic', bridgeUrl: `http://127.0.0.1:${server.address().port}`,
    ipcTokenEnv: 'ADAPTER_SMOKE_IPC', sourceTokenEnv: 'ADAPTER_SMOKE_SOURCE', sessionIds: ['synthetic'], includeAllSessions: false,
    connectionFile: new URL('./not-configured.json', import.meta.url).pathname });
  await adapter.inertia; assert.equal(adapter.state, 2);
  await start(client, Registry);
  const owner = { principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'answer' };
  client.provide('connection', { interactions: 'none', rpc: { open() {}, call: (prefix, endpoint, payload, signal) => host.typertGateway.dispatchRpc(endpoint, payload, signal, owner) } });
  await start(client, ClientGateway);
  let selected = {}; let opens = 0;
  client.provide('uiWorkspace', { openSession(id) { opens++; selected = { sessionId: id }; }, selection: { getSnapshot: () => selected } });
  let module;
  globalThis.window = { __ModuleLoader__: { load: (value) => { module = value; } } };
  runInThisContext(await readFile(new URL('../src/client.js', import.meta.url), 'utf8'));
  assert.equal(module.id, '@ai-passport/dsh-agent-pet');
  const requireLocal = createRequire(import.meta.url);
  const browserPlugin = module.factory((name) => { assert.equal(name, 'zod'); return requireLocal('zod'); });
  const companion = await start(client, browserPlugin);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(opens, 1); assert.equal(selected.sessionId, 'synthetic'); assert.equal(finished, true);
  const capability = received.filter((value) => value.path === '/v1/events').at(-1).body.event.capabilities;
  assert.equal(capability.open_on_host, true);
  const diagnostic = await host.typertGateway.dispatchRpc('agentPetNavigation/diagnostics', { args: {} }, new AbortController().signal, owner);
  assert.equal(diagnostic.ok, true); assert.equal(diagnostic.value.selected_live, 1);
  assert.ok(diagnostic.value.event_posts_accepted > 0);
  assert.equal(JSON.stringify(diagnostic.value).includes('synthetic'), false);
  const outsider = { ...owner, principal: { kind: 'shared', id: 'synthetic-outsider' } };
  const denied = await host.typertGateway.dispatchRpc('agentPetNavigation/poll', { args: { clientId: 'outsider' } }, new AbortController().signal, outsider);
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'agent-pet/owner-required');
  await companion.dispose();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(opens, 1);
  await adapter.dispose();
  console.log('PASS real host/client Gateway, browser bundle factory, command IPC, selected-session confirmation, owner-only access and unload');
} finally {
  await client.fiber.dispose(); await host.fiber.dispose(); hook.deregister();
  await new Promise((resolve) => server.close(resolve));
  delete globalThis.window; delete process.env.ADAPTER_SMOKE_IPC; delete process.env.ADAPTER_SMOKE_SOURCE;
}
