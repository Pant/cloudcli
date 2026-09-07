import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { normalizedToChatMessages, stabilizeRenderedMessages } from './useChatMessages';

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

test('partial-to-final normalization keeps the same message identity without duplicate rows', () => {
  const shared = {
    id: 'response-1',
    sessionId: 'session-1',
    timestamp: '2026-08-11T00:00:00.000Z',
    role: 'assistant' as const,
    provider: 'claude' as const,
  };
  const partial = normalizedToChatMessages([{ ...shared, kind: 'stream_delta', content: 'Hello **wor' }]);
  const final = normalizedToChatMessages([{ ...shared, kind: 'text', content: 'Hello **world**' }]);

  assert.equal(partial.length, 1);
  assert.equal(final.length, 1);
  assert.equal(partial[0].id, final[0].id);
  assert.equal(partial[0].isStreaming, true);
  assert.equal(final[0].isStreaming, undefined);
  assert.equal(final[0].content, 'Hello **world**');
});
