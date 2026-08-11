import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('built output has one injected worker registration and coherent shell graph', async () => {
  const [html, worker] = await Promise.all([
    readFile(new URL('../../dist/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/sw.js', import.meta.url), 'utf8'),
  ]);
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.equal(html.includes('serviceWorker.register'), false);
  assert.equal(worker.includes('__CLOUDCLI_'), false);
  const shell = JSON.parse(worker.match(/const SHELL_FILES = (\[[^;]+\]);/)?.[1] || 'null');
  assert.ok(shell.includes('index.html'));
  assert.ok(shell.includes('manifest.json'));
  for (const script of scripts.filter(value => value.includes('/assets/'))) assert.ok(shell.includes(script.replace(/^\.?\//, '')));
});
