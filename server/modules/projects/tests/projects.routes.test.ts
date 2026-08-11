import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('project list route defaults to a database snapshot and keeps explicit synchronization available', async () => {
  const source = await readFile(new URL('../projects.routes.ts', import.meta.url), 'utf8');

  assert.match(source, /req\.query\.synchronize/);
  assert.match(source, /getProjectsWithSessions\(\{[\s\S]*synchronize,/);
  assert.doesNotMatch(source, /const skipSynchronization/);
});
