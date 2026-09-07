import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

test('built output has one injected worker registration and coherent shell graph', async () => {
  const [html, worker] = await Promise.all([
    readFile(new URL('../../dist/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/sw.js', import.meta.url), 'utf8'),
  ]);
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.equal(html.includes('serviceWorker.register'), false);
  assert.match(html, /rel="manifest" href="(?:\.\/|\/)manifest\.json"/);
  assert.doesNotMatch(html, /%BASE_URL%/);
  assert.equal(worker.includes('__CLOUDCLI_'), false);
  const shell = JSON.parse(worker.match(/const SHELL_FILES = (\[[^;]+\]);/)?.[1] || 'null');
  assert.ok(Array.isArray(shell));
  assert.deepEqual(shell.slice(0, 3), ['index.html', 'manifest.json', 'cloudcli-version.json']);
  assert.deepEqual(shell.slice(3), [...shell.slice(3)].sort());
  assert.equal(new Set(shell).size, shell.length);
  for (const file of shell) {
    assert.match(file, /^(?:index\.html|manifest\.json|cloudcli-version\.json|assets\/[^/]+\.(?:js|css))$/);
    assert.equal((await stat(new URL(`../../dist/${file}`, import.meta.url))).isFile(), true, `${file} must exist in dist`);
  }
  assert.ok(shell.includes('index.html'));
  assert.ok(shell.includes('manifest.json'));
  assert.ok(shell.includes('cloudcli-version.json'));
  for (const script of scripts.filter(value => value.includes('/assets/'))) assert.ok(shell.includes(script.replace(/^\.?\//, '')));
});
