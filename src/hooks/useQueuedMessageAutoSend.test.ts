import assert from 'node:assert/strict';
import test from 'node:test';

import { readQueuedMessage, writeQueuedMessage } from '../components/chat/utils/chatStorage';

import { flushQueuedMessageAutoSend, type QueuedMessageAutoSendState } from './useQueuedMessageAutoSend';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

const createState = (): QueuedMessageAutoSendState => ({
  previousProcessing: new Set(['session-1']),
  readyToSend: new Set(),
  accepted: new Set(),
});

test.beforeEach(() => values.clear());

test('socket-close and false-return races retain the queued record without processing state', () => {
  writeQueuedMessage('session-1', { content: 'retain me', attachments: [{ name: 'file.txt' }] });
  const state = createState();
  let sends = 0;
  let marks = 0;
  const run = (socketOpen: boolean) => flushQueuedMessageAutoSend({
    state,
    processingSessions: new Map(),
    activeSessionId: null,
    socketOpen,
    sendMessage: () => {
      sends += 1;
      return false;
    },
    markSessionProcessing: () => { marks += 1; },
  });

  run(false);
  assert.equal(sends, 0);
  run(true);
  assert.equal(sends, 1);
  assert.equal(marks, 0);
  assert.equal(readQueuedMessage('session-1')?.content, 'retain me');
});

test('accepted reconnect send clears once and is not duplicated by repeated effects', () => {
  writeQueuedMessage('session-1', { content: 'send once' });
  const state = createState();
  let sends = 0;
  let marks = 0;
  const run = () => flushQueuedMessageAutoSend({
    state,
    processingSessions: new Map(),
    activeSessionId: null,
    socketOpen: true,
    sendMessage: () => { sends += 1; return true; },
    markSessionProcessing: () => { marks += 1; },
  });

  run();
  run();
  assert.equal(sends, 1);
  assert.equal(marks, 1);
  assert.equal(readQueuedMessage('session-1'), null);
});
