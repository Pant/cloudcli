import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { stabilizeRenderedMessages } from './useChatMessages';

const message = (id: string, content: string): ChatMessage => ({
  id,
  type: 'assistant',
  content,
  timestamp: '2026-08-11T00:00:00.000Z',
});

test('stabilizeRenderedMessages reuses completed rows while replacing a growing stream', () => {
  const completed = message('completed', 'stable');
  const streaming = { ...message('stream', 'a'), isStreaming: true };
  const next = stabilizeRenderedMessages([completed, streaming], [
    message('completed', 'stable'),
    { ...message('stream', 'ab'), isStreaming: true },
  ]);

  assert.equal(next[0], completed);
  assert.notEqual(next[1], streaming);
});

test('stabilizeRenderedMessages returns the previous array for an equivalent transcript', () => {
  const previous = [message('completed', 'stable')];
  assert.equal(stabilizeRenderedMessages(previous, [message('completed', 'stable')]), previous);
});
