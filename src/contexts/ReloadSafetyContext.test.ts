import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('reload safety centralizes blockers and beforeunload decisions', async () => {
  const source = await readFile(new URL('./ReloadSafetyContext.tsx', import.meta.url), 'utf8');
  assert.match(source, /isReloadSafe/);
  assert.match(source, /setReloadBlocker/);
  assert.match(source, /confirmReload/);
  assert.match(source, /addEventListener\('beforeunload'/);
});

test('websocket reconnect reload uses the shared reload guard without build polling', async () => {
  const source = await readFile(new URL('./WebSocketContext.tsx', import.meta.url), 'utf8');
  assert.match(source, /useReloadSafety\(\)/);
  assert.equal((source.match(/confirmReload\(/g) ?? []).length, 1);
  assert.doesNotMatch(source, /cloudcli-version\.json/);
  assert.doesNotMatch(source, /DOMParser/);
  assert.doesNotMatch(source, /fetch\('\/'/);
});
