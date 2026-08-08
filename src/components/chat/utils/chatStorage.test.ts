import assert from 'node:assert/strict';
import test from 'node:test';

import {
  patchQueuedMessageOptions,
  queuedMessageKey,
  readQueuedMessage,
  writeQueuedMessage,
} from './chatStorage';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  },
});

test.beforeEach(() => values.clear());

test('patches queued model, effort, and agent while preserving the rest of the message', () => {
  const attachments = [{ name: 'diagram.png', path: '/assets/diagram.png' }];
  const toolsSettings = { allowedTools: ['Read'], disallowedTools: ['Bash'] };
  writeQueuedMessage('session-1', {
    content: 'follow up',
    attachments,
    options: {
      model: 'old-model',
      effort: 'low',
      agent: 'Architect',
      permissionMode: 'plan',
      toolsSettings,
      skipPermissions: false,
      sessionSummary: 'Existing summary',
    },
  });

  const patched = patchQueuedMessageOptions('session-1', {
    model: 'new-model',
    effort: 'high',
    agent: 'Code',
  });

  assert.deepEqual(patched, {
    content: 'follow up',
    attachments,
    options: {
      model: 'new-model',
      effort: 'high',
      agent: 'Code',
      permissionMode: 'plan',
      toolsSettings,
      skipPermissions: false,
      sessionSummary: 'Existing summary',
    },
  });
  assert.deepEqual(readQueuedMessage('session-1'), patched);
});

test('patches only the requested queued option', () => {
  writeQueuedMessage('session-2', {
    content: 'next',
    attachments: [{ name: 'notes.txt' }],
    options: { model: 'model-a', effort: 'medium', agent: 'Architect', permissionMode: 'acceptEdits' },
  });

  patchQueuedMessageOptions('session-2', { effort: 'default' });

  assert.deepEqual(readQueuedMessage('session-2')?.options, {
    model: 'model-a',
    effort: 'default',
    agent: 'Architect',
    permissionMode: 'acceptEdits',
  });
});

test('missing queued messages are not created by an option patch', () => {
  assert.equal(patchQueuedMessageOptions('missing', { model: 'new-model' }), null);
  assert.equal(values.has(queuedMessageKey('missing')), false);
});
