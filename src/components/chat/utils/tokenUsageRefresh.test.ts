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

  assert.deepEqual(requests, ['tokens:session-a', 'messages:session-a']);
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
    'tokens:session-a',
    'messages:session-a',
    'tokens:session-a',
    'messages:session-a',
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
  while (pending.length < 2) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  pending[0]?.({ used: 100, windowTokens: 40 });
  pending[1]?.({ used: 200, windowTokens: 90 });
  await first;
  await second;
  assert.deepEqual(applied, [{ used: 200, windowTokens: 90 }]);

  const differentSession = controller.handleComplete({ sessionId: 'session-a', success: true });
  activeSessionId = 'session-b';
  await new Promise<void>((resolve) => setImmediate(resolve));
  pending[2]?.({ used: 400, windowTokens: 180 });
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

test('OpenCode retries sequentially until delayed canonical metadata is ready', async () => {
  let attempts = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const waits: number[] = [];
  const requests: string[] = [];
  const baseline = { count: 1 };
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => 'session-a',
    getActiveSessionKey: () => 'session-a:0',
    shouldRetryMessages: () => true,
    captureMetadataBaseline: () => baseline,
    isMetadataReady: (_sessionId, captured) => captured === baseline && attempts >= 3,
    retryDelaysMs: [10, 20, 30],
    wait: async (delayMs) => { waits.push(delayMs); },
    refreshMessages: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      attempts += 1;
      requests.push(`messages:${attempts}`);
      await Promise.resolve();
      inFlight -= 1;
    },
    fetchTokenUsage: async () => {
      requests.push('tokens');
      return { used: 300 };
    },
    applySnapshot: () => undefined,
  });

  await controller.handleComplete({ sessionId: 'session-a', success: true });

  assert.deepEqual(requests, ['tokens', 'messages:1', 'messages:2', 'messages:3']);
  assert.deepEqual(waits, [10, 20]);
  assert.equal(maxInFlight, 1);
});

test('OpenCode stops after the immediate attempt when metadata is ready', async () => {
  let attempts = 0;
  let tokenFetches = 0;
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => 'session-a',
    getActiveSessionKey: () => 'session-a:0',
    shouldRetryMessages: () => true,
    captureMetadataBaseline: () => ({ count: 0 }),
    isMetadataReady: () => attempts === 1,
    retryDelaysMs: [1, 2],
    wait: async () => assert.fail('ready metadata must not schedule a retry'),
    refreshMessages: async () => { attempts += 1; },
    fetchTokenUsage: async () => { tokenFetches += 1; return { used: 1 }; },
    applySnapshot: () => undefined,
  });

  await controller.handleComplete({ sessionId: 'session-a', success: true });
  assert.equal(attempts, 1);
  assert.equal(tokenFetches, 1);
});

test('OpenCode exhaustion and refresh failures still fetch aggregate usage once', async () => {
  let attempts = 0;
  let errors = 0;
  let tokenFetches = 0;
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => 'session-a',
    getActiveSessionKey: () => 'session-a:0',
    shouldRetryMessages: () => true,
    captureMetadataBaseline: () => ({ count: 0 }),
    isMetadataReady: () => false,
    retryDelaysMs: [1, 2],
    wait: async () => undefined,
    refreshMessages: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('not settled');
    },
    fetchTokenUsage: async () => { tokenFetches += 1; return { used: 1 }; },
    applySnapshot: () => undefined,
    onError: () => { errors += 1; },
  });

  await controller.handleComplete({ sessionId: 'session-a', success: true });
  assert.equal(attempts, 3);
  assert.equal(errors, 1);
  assert.equal(tokenFetches, 1);
});

test('new completion ticket cancels an older retry before its delayed refresh', async () => {
  const pendingWaits: Array<() => void> = [];
  let attempts = 0;
  let tokenFetches = 0;
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => 'session-a',
    getActiveSessionKey: () => 'session-a:0',
    shouldRetryMessages: () => true,
    captureMetadataBaseline: () => ({ count: attempts }),
    isMetadataReady: () => attempts >= 2,
    retryDelaysMs: [1],
    wait: async () => new Promise<void>((resolve) => pendingWaits.push(resolve)),
    refreshMessages: async () => { attempts += 1; },
    fetchTokenUsage: async () => { tokenFetches += 1; return { used: attempts }; },
    applySnapshot: () => undefined,
  });

  const stale = controller.handleComplete({ sessionId: 'session-a', success: true });
  while (pendingWaits.length < 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const current = controller.handleComplete({ sessionId: 'session-a', success: true });
  pendingWaits[0]?.();
  await stale;
  await current;
  assert.equal(attempts, 2);
  assert.equal(tokenFetches, 2);
});

test('session or view-generation switch cancels retries and fences aggregate results', async () => {
  let activeSessionId: string | null = 'session-a';
  let viewKey: string | null = 'session-a:0';
  let attempts = 0;
  let tokenFetches = 0;
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => activeSessionId,
    getActiveSessionKey: () => viewKey,
    shouldRetryMessages: () => true,
    captureMetadataBaseline: () => ({ count: 0 }),
    isMetadataReady: () => false,
    retryDelaysMs: [1],
    wait: async () => { viewKey = 'session-a:1'; },
    refreshMessages: async () => { attempts += 1; },
    fetchTokenUsage: async () => { tokenFetches += 1; return { used: 1 }; },
    applySnapshot: () => undefined,
  });

  await controller.handleComplete({ sessionId: 'session-a', success: true });
  assert.equal(attempts, 1);
  assert.equal(tokenFetches, 1);

  viewKey = 'session-a:0';
  activeSessionId = 'session-a';
  const switched = createCompletionTokenRefreshController({
    getActiveSessionId: () => activeSessionId,
    getActiveSessionKey: () => viewKey,
    shouldRetryMessages: () => true,
    captureMetadataBaseline: () => ({ count: 0 }),
    isMetadataReady: () => false,
    retryDelaysMs: [1],
    wait: async () => { activeSessionId = 'session-b'; },
    refreshMessages: async () => { attempts += 1; },
    fetchTokenUsage: async () => { tokenFetches += 1; return { used: 1 }; },
    applySnapshot: () => undefined,
  });
  await switched.handleComplete({ sessionId: 'session-a', success: true });
  assert.equal(attempts, 2);
  assert.equal(tokenFetches, 2);
});

test('aggregate usage starts immediately while canonical retry delay remains pending', async () => {
  let releaseWait: (() => void) | undefined;
  const requests: string[] = [];
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => 'session-a',
    getActiveSessionKey: () => 'session-a:0',
    shouldRetryMessages: () => true,
    captureMetadataBaseline: () => ({ count: 0 }),
    isMetadataReady: () => false,
    retryDelaysMs: [1],
    wait: () => new Promise<void>((resolve) => { releaseWait = resolve; }),
    refreshMessages: async () => { requests.push('messages'); },
    fetchTokenUsage: async () => { requests.push('tokens'); return { used: 1 }; },
    applySnapshot: () => undefined,
  });

  const completion = controller.handleComplete({ sessionId: 'session-a', success: true });
  while (!releaseWait) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ['tokens', 'messages']);
  releaseWait();
  await completion;
});

test('aggregate fallback cannot replace a newer trustworthy live snapshot', async () => {
  let snapshotVersion = 0;
  let resolveTokens: ((snapshot: unknown) => void) | undefined;
  const applied: unknown[] = [];
  const controller = createCompletionTokenRefreshController({
    getActiveSessionId: () => 'session-a',
    getActiveSessionKey: () => 'session-a:0',
    getSnapshotVersion: () => snapshotVersion,
    refreshMessages: async () => undefined,
    fetchTokenUsage: () => new Promise((resolve) => { resolveTokens = resolve; }),
    applySnapshot: (snapshot) => applied.push(snapshot),
  });

  const completion = controller.handleComplete({ sessionId: 'session-a', success: true });
  while (!resolveTokens) await new Promise<void>((resolve) => setImmediate(resolve));
  snapshotVersion += 1;
  resolveTokens({ used: 10 });
  await completion;
  assert.deepEqual(applied, []);
});
