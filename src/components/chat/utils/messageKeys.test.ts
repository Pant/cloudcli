import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizedToChatMessages } from '../hooks/useChatMessages';

import { getIntrinsicMessageKey } from './messageKeys';

test('normalized identity and realtime metadata survive rendering', () => {
  const [message] = normalizedToChatMessages([{ id: 'row-1', sessionId: 's', timestamp: '2026-01-01T00:00:00Z', provider: 'claude', kind: 'text', role: 'assistant', content: 'hi', generation: 3, seq: 8 }]);
  assert.equal(message.id, 'row-1');
  assert.equal(message.generation, 3);
  assert.equal(message.seq, 8);
  assert.equal(getIntrinsicMessageKey(message), 'message-row-1-g3');
});

test('split task notification rows get deterministic distinct keys', () => {
  const messages = normalizedToChatMessages([{ id: 'row-2', sessionId: 's', timestamp: '2026-01-01T00:00:00Z', provider: 'claude', kind: 'text', role: 'user', content: '<task-notification><status>completed</status><summary>done</summary><result>result</result></task-notification>' }]);
  assert.deepEqual(messages.map(getIntrinsicMessageKey), ['message-row-2-task-notification', 'message-row-2-task-result']);
});

test('response metadata survives conversion unchanged on its provider message', () => {
  const responseMetadata = { inputTokens: 1234, outputTokens: 56, timestamp: '2026-04-08T10:30:00Z' };
  const [message] = normalizedToChatMessages([{ id: 'row-3', sessionId: 's', timestamp: '2026-04-08T10:30:00Z', provider: 'opencode', kind: 'text', role: 'assistant', content: 'done', responseMetadata }]);

  assert.equal(message.provider, 'opencode');
  assert.strictEqual(message.responseMetadata, responseMetadata);
});

test('response metadata is not duplicated onto synthetic task notification splits', () => {
  const messages = normalizedToChatMessages([{ id: 'row-4', sessionId: 's', timestamp: '2026-04-08T10:30:00Z', provider: 'opencode', kind: 'text', role: 'user', content: '<task-notification><status>completed</status><summary>done</summary><result>result</result></task-notification>', responseMetadata: { inputTokens: 1, outputTokens: 2, timestamp: '2026-04-08T10:30:00Z' } }]);

  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.responseMetadata === undefined));
});
