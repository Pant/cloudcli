import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizedToChatMessages } from './useChatMessages';

const taskMessage = (content: unknown, isError: boolean) => normalizedToChatMessages([{
  id: 'task-recovery-1',
  sessionId: 'session-1',
  timestamp: '2026-08-11T01:02:03.000Z',
  role: 'assistant',
  provider: 'opencode',
  kind: 'tool_use',
  toolName: 'Task',
  toolId: 'task-tool-recovery-1',
  toolInput: { description: 'Delegate' },
  toolResult: { content, isError } as never,
}])[0];

test('Task results with absent content remain complete without fabricated text', () => {
  for (const content of [undefined, null]) {
    const converted = taskMessage(content, true);
    assert.equal(converted.toolResult?.content, '');
    assert.equal(converted.toolResult?.isError, true);
  }
});

test('tool result formatting preserves readable structured content and error wrappers', () => {
  const structured = taskMessage({ status: 'done', count: 2 }, false);
  const wrapped = taskMessage('<tool_use_error>provider failed</tool_use_error>', true);

  assert.equal(structured.toolResult?.content, '{"status":"done","count":2}');
  assert.equal(wrapped.toolResult?.content, 'provider failed');
});

test('unstringifiable Task result content cannot crash normalization', () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;

  const converted = taskMessage(circular, false);
  assert.equal(converted.toolResult?.content, '');
  assert.equal(converted.toolResult?.isError, false);
});
