import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('version checks have one shared owner and defer, pause, and resume network work', async () => {
  const source = await readFile(new URL('./useVersionCheck.ts', import.meta.url), 'utf8');
  assert.match(source, /let started = false/);
  assert.match(source, /useSyncExternalStore/);
  assert.match(source, /schedule\(owner, repo, 5_000\)/);
  assert.match(source, /document\.visibilityState === 'hidden'/);
  assert.match(source, /navigator\.onLine === false/);
  assert.match(source, /addEventListener\('visibilitychange'/);
  assert.match(source, /addEventListener\('online'/);
  assert.equal((source.match(/setInterval/g) ?? []).length, 0);
});

test('shared version owner checks health and one external release resource', async () => {
  const source = await readFile(new URL('./useVersionCheck.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/fetch\('\/health'\)/g) ?? []).length, 1);
  assert.equal((source.match(/api\.github\.com\/repos/g) ?? []).length, 1);
});
