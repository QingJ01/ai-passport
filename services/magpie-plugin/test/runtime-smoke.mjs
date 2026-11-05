// Read-only packaged-runtime check. Run with Electron's Node mode; never boots DSH.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { normalizeUsage, COMPATIBLE_DSH } from '../src/projection.mjs';
const runtime = process.env.DSH_TEST_RUNTIME;
if (!runtime) throw new Error('Set DSH_TEST_RUNTIME to the installation dsh directory');
const load = (name) => import(pathToFileURL(`${runtime}/node_modules/@deepseek-ai/${name}/lib/index.js`).href);
const { Context } = await load('cordis');
const { default: Projections } = await load('dsh-session-projection');
const { default: TokenMeter } = await load('dsh-token-meter');
const { getDshRuntimeVersion, evaluatePluginCompatibility, loadOptionalPatches, composeEntries } = await load('dsh-app-boot');
assert.equal(getDshRuntimeVersion(), COMPATIBLE_DSH);
const ctx = new Context();
const projectionFiber = ctx.plugin(Projections);
await projectionFiber.inertia;
const meterFiber = ctx.plugin(TokenMeter);
await meterFiber.inertia;
assert.equal(meterFiber.state, 2);
const settle = (n) => ({ type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: n, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } } }] } });
const events = [settle(10), settle(7), { type: 'llm/retry-started', data: { turn: 1, step: 1 } }, settle(5)]
  .map((event, seq) => ({ ...event, seq }));
// Real host fold: 10 replaced by 7, retry bills a new 5 => 12; output 2+2.
const restored = ctx.sessionProjections.restore({}, events, 0, { id: 'synthetic', isSeeded: false }, 0);
assert.deepEqual(restored.snapshot.values.tokenUsage, { uncachedInputTokens: 12, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 8 });
const usage = normalizeUsage(restored.snapshot, { header: { isSeeded: false }, inheritedEventCount: 0 });
assert.equal(usage.input_tokens, '12');
const { readFile } = await import('node:fs/promises');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(evaluatePluginCompatibility(manifest, {}), undefined);
const patches = loadOptionalPatches('adapter-test', new URL('../cordis.patch.yml', import.meta.url).pathname);
const entries = composeEntries([patches]);
assert.equal(entries[0].name, manifest.name);
assert.equal(entries[0].id, 'agent-pet-adapter');
await ctx.fiber.dispose();
console.log('PASS real DSH version, tokenUsage replacement/retry reduction, manifest compatibility and bundle patch');
