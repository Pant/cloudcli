import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompletionTokenRefreshController } from './tokenUsageRefresh';

test('each successful completion refreshes the active session and applies the comprehensive snapshot', async () => {
  let activeSessionId: string | null = 'session-a';
  const applied: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => activeSessionId,
    getActiveSessionKey: () => activeSessionId,
    refreshMessages: async (sessionId) => requests.push(`messages:${sessionId}`),
    fetchTokenUsage: async (sessionId) => {
      requests.push(`tokens:${sessionId}`);
      return {
        used: 300,
        windowTokens: 120,
        inputTokens: 240,
        outputTokens: 60,
        breakdown: { input: 240, output: 60 },
      };
    },
    applySnapshot: (snapshot) => applied.push(snapshot),
  });

  await controller.handleComplete({ sessionId: 'session-a', success: true });

  assert.deepEqual(requests, ['messages:session-a', 'tokens:session-a']);
  assert.deepEqual(applied, [{
    used: 300,
    windowTokens: 120,
    inputTokens: 240,
    outputTokens: 60,
    breakdown: { input: 240, output: 60 },
  }]);
  activeSessionId = null;
});

test('two sequential successful completions each perform a session-scoped refresh', async () => {
  const requests: string[] = [];
  const applied: number[] = [];
  let responseNumber = 0;
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => 'session-a',
    getActiveSessionKey: () => 'session-a',
    refreshMessages: async (sessionId) => requests.push(`messages:${sessionId}`),
    fetchTokenUsage: async (sessionId) => {
      requests.push(`tokens:${sessionId}`);
      responseNumber += 1;
      return { used: responseNumber * 100, windowTokens: responseNumber * 40 };
    },
    applySnapshot: (snapshot) => applied.push(Number(snapshot.used)),
  });

  await controller.handleComplete({ sessionId: 'session-a', success: true });
  await controller.handleComplete({ sessionId: 'session-a', success: true });

  assert.deepEqual(requests, [
    'messages:session-a',
    'tokens:session-a',
    'messages:session-a',
    'tokens:session-a',
  ]);
  assert.deepEqual(applied, [100, 200]);
});

test('stale completion results cannot overwrite a newer response or a different session', async () => {
  let activeSessionId: string | null = 'session-a';
  const pending: Array<(snapshot: unknown) => void> = [];
  const applied: Record<string, unknown>[] = [];
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => activeSessionId,
    getActiveSessionKey: () => activeSessionId,
    refreshMessages: async () => undefined,
    fetchTokenUsage: async () => new Promise((resolve) => pending.push(resolve)),
    applySnapshot: (snapshot) => applied.push(snapshot),
  });

  const first = controller.handleComplete({ sessionId: 'session-a', success: true });
  const second = controller.handleComplete({ sessionId: 'session-a', success: true });
  while (pending.length < 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  pending[0]?.({ used: 200, windowTokens: 90 });
  await first;
  await second;
  assert.deepEqual(applied, [{ used: 200, windowTokens: 90 }]);

  const differentSession = controller.handleComplete({ sessionId: 'session-a', success: true });
  activeSessionId = 'session-b';
  await new Promise<void>((resolve) => setImmediate(resolve));
  pending[1]?.({ used: 400, windowTokens: 180 });
  await differentSession;
  assert.deepEqual(applied, [{ used: 200, windowTokens: 90 }]);
});

test('failed or unsupported completion refreshes retain the prior snapshot', async () => {
  let applied = 0;
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => 'session-a',
    getActiveSessionKey: () => 'session-a',
    refreshMessages: async () => undefined,
    fetchTokenUsage: async () => ({ unsupported: true, used: 0 }),
    applySnapshot: () => { applied += 1; },
    onError: () => undefined,
  });

  await controller.handleComplete({ sessionId: 'session-a', success: true });
  assert.equal(applied, 0);
  assert.equal(controller.handleComplete({ sessionId: 'session-a', success: false }), undefined);
});
