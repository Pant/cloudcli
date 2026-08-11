import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = () => readFile(new URL('./editorRecoveryStore.ts', import.meta.url), 'utf8');

test('recovery records are account/project/file scoped and bounded', async () => {
  const text = await source();
  assert.match(text, /keyPath: \['accountId', 'projectId', 'filePath'\]/);
  assert.match(text, /EDITOR_RECOVERY_LIMIT = 50/);
  assert.match(text, /records\.length - EDITOR_RECOVERY_LIMIT/);
});

test('schema upgrades preserve existing stores and records', async () => {
  const text = await source();
  assert.match(text, /if \(!database\.objectStoreNames\.contains\(EDITOR_RECOVERY_STORE\)\)/);
  assert.doesNotMatch(text, /deleteDatabase|clear\(\)/);
});
