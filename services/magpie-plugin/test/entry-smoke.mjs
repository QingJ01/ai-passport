// Isolated real Cordis composition. No profile, personal data, or global installation.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
const runtime = process.env.DSH_TEST_RUNTIME;
if (!runtime) throw new Error('Set DSH_TEST_RUNTIME');
const requireRuntime = createRequire(pathToFileURL(`${runtime}/package.json`));
const root = new URL('..', import.meta.url).href;
// Model the runtime's peer resolver only in this disposable test process.
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(root)) {
    return nextResolve(pathToFileURL(requireRuntime.resolve(specifier)).href, context);
  }
  return nextResolve(specifier, context);
} });
const load = (name) => import(pathToFileURL(`${runtime}/node_modules/@deepseek-ai/${name}/lib/index.js`).href);
const { Context } = await load('cordis');
const { default: Projections } = await load('dsh-session-projection');
const { SessionStore } = await load('dsh-session');
const { AgentRegistry } = await load('dsh-agent');
const { default: TokenMeter } = await load('dsh-token-meter');
const { default: Questions } = await load('dsh-user-questions');
const { default: TypertRegistry } = await load('dsh-typert-registry');
const entry = await import('../src/index.mjs');
const received = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  received.push({ path: req.url, body: JSON.parse(body) }); res.writeHead(204); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ctx = new Context();
try {
  for (const plugin of [TypertRegistry, Projections, SessionStore, AgentRegistry, TokenMeter, Questions]) {
    const fiber = ctx.plugin(plugin); await fiber.inertia;
    assert.equal(fiber.state, 2, plugin.name);
  }
  process.env.ADAPTER_SMOKE_IPC = 'x'.repeat(40);
  process.env.ADAPTER_SMOKE_SOURCE = 'y'.repeat(40);
  const session = ctx.sessions.create('synthetic', { meta: {} });
  const agent = { id: 'synthetic', session, status: 'running', ctx };
  const removeAgent = ctx.agents.enter(agent);
  const fiber = ctx.plugin(entry, { sourceId: 'synthetic', bridgeUrl: `http://127.0.0.1:${server.address().port}`,
    ipcTokenEnv: 'ADAPTER_SMOKE_IPC', sourceTokenEnv: 'ADAPTER_SMOKE_SOURCE', sessionIds: ['synthetic'], includeAllSessions: false,
    connectionFile: new URL('./not-configured.json', import.meta.url).pathname });
  await fiber.inertia;
  assert.equal(fiber.state, 2, 'actual exported entry activates');
  session.append('turn/start', { turn: 1 });
  let answerResolve;
  const answer = { answers: [{ id: 'q', selected: ['yes'] }] };
  // Install existing answerer AFTER plugin. Observer must still delegate unchanged.
  const removeAnswerer = ctx.on('user-questions/request', () => new Promise((resolve) => { answerResolve = resolve; }));
  const pending = ctx.userQuestions.ask({ agent, questions: [{ id: 'q', question: 'synthetic question only' }] });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const running = received.filter((value) => value.path === '/v1/events').at(-1)?.body.event;
  assert.equal(running?.execution_state, 'running');
  assert.equal(running.pending_interactions.length, 1);
  assert.equal(running.pending_interactions[0].blocks_execution, true);
  assert.ok(!JSON.stringify(received).includes('synthetic question only'));
  answerResolve(answer);
  assert.equal(await pending, answer);
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const ended = received.filter((value) => value.path === '/v1/events').at(-1)?.body.event;
  assert.equal(ended.turn_outcome, 'ended'); assert.equal(ended.task_outcome, null);
  assert.equal(ended.pending_interactions.length, 0);
  await fiber.dispose();
  assert.equal(received.at(-1).body.connected, false);
  removeAnswerer(); removeAgent();
  console.log('PASS actual exported entry, Cordis injection, real live registry, question delegation, event IPC and unload');
} finally {
  await ctx.fiber.dispose();
  hook.deregister();
  await new Promise((resolve) => server.close(resolve));
  delete process.env.ADAPTER_SMOKE_IPC; delete process.env.ADAPTER_SMOKE_SOURCE;
}
