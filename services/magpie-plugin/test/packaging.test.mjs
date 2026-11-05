import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { COMPATIBLE_DSH } from '../src/projection.mjs';
const root = new URL('..', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

test('published archive includes actual exported loader entry and declared bundle patch', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.engines.dsh, COMPATIBLE_DSH);
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-token-meter'], COMPATIBLE_DSH);
  assert.equal(manifest.exports['.'], manifest.main);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.exports['./client'], './src/client.js');
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-workspace']);
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok((await read('src/client.js')).includes("id: '@ai-passport/dsh-agent-pet'"));
  assert.equal(manifest.scripts.preinstall, undefined);
  assert.equal(manifest.scripts.postinstall, undefined);
  const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))[0];
  const paths = new Set(pack.files.map((file) => file.path));
  for (const path of ['package.json', 'cordis.patch.yml', 'src/index.mjs', 'src/adapter.mjs', 'src/projection.mjs', 'src/transport.mjs', 'src/client.js', 'src/client-core.mjs', 'src/remote-definition.mjs', 'src/navigation.mjs', 'src/navigation-service.mjs', 'src/connection.mjs', 'tools/build-client.mjs', 'README.md', 'README.zh_CN.md']) {
    assert.ok(paths.has(path), `missing ${path}`);
  }
  assert.ok(![...paths].some((path) => path.includes('node_modules') || path.endsWith('.env') || path.startsWith('test/')));
});
