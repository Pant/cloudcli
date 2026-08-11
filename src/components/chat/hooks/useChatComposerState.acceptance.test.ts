import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptedPermissionRequestIds } from './useChatComposerState';

test('permission actions disappear only when their individual transport send is accepted', () => {
  const attempts: string[] = [];
  const accepted = acceptedPermissionRequestIds(['accepted', 'raced', 'failed'], (requestId) => {
    attempts.push(requestId);
    return requestId === 'accepted';
  });

  assert.deepEqual(attempts, ['accepted', 'raced', 'failed']);
  assert.deepEqual(accepted, ['accepted']);
  assert.deepEqual(
    ['accepted', 'raced', 'failed'].filter((requestId) => !accepted.includes(requestId)),
    ['raced', 'failed'],
  );
});

test('composer source commits optimistic and clearing state only after accepted transport', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./useChatComposerState.ts', import.meta.url), 'utf8');
  const acceptance = source.indexOf('const accepted = sendMessage({', source.indexOf('const userMessage'));
  const rejection = source.indexOf('if (!accepted)', acceptance);
  const optimistic = source.indexOf('addMessage(userMessage)', rejection);
  const processing = source.indexOf('onSessionProcessing?.(targetSessionId', optimistic);
  const clearInput = source.indexOf("setInput('')", processing);

  assert.ok(acceptance > 0 && rejection > acceptance);
  assert.ok(optimistic > rejection && processing > optimistic && clearInput > processing);
});
