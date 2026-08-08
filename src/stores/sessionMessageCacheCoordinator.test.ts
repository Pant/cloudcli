import assert from 'node:assert/strict';
import test from 'node:test';

import type { ServerEvent } from '../contexts/webSocketTypes';

import type { NormalizedMessage } from './normalizedMessage';
import {
  AUTOMATIC_CACHE_SYNC_CONCURRENCY,
  canRunSessionCacheSync,
  getPersistableMessageEvent,
  MANUAL_CACHE_SYNC_CONCURRENCY,
  parseSessionCacheManifest,
  planSessionCacheSync,
  runWithConcurrency,
  SessionCacheSyncCoordinator,
  type SessionCacheManifestEntry,
} from './sessionMessageCacheCoordinator';

const entry = (sessionId: string, revision: string, overrides: Partial<SessionCacheManifestEntry> = {}): SessionCacheManifestEntry => ({
  sessionId,
  provider: 'claude',
  revision,
  archived: false,
  historyReady: true,
  ...overrides,
});

const event = (overrides: Partial<ServerEvent> = {}): ServerEvent => ({
  kind: 'text',
  id: 'message-1',
  sessionId: 'session-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  content: 'hello',
  ...overrides,
});

test('plans changed and missing revisions but skips unchanged entries', () => {
  const plans = planSessionCacheSync({
    manifest: [entry('unchanged', 'rev-1'), entry('changed', 'rev-2'), entry('missing', 'rev-3')],
    cachedMetadata: new Map([
      ['unchanged', { revision: 'rev-1', historyReady: true }],
      ['changed', { revision: 'rev-1', historyReady: true }],
    ]),
  });

  assert.deepEqual(plans.map((plan) => [plan.entry.sessionId, plan.reason]), [
    ['changed', 'changed'],
    ['missing', 'missing'],
  ]);
});

test('force plans every unchanged history-ready session but excludes metadata-only rows', () => {
  const plans = planSessionCacheSync({
    manifest: [
      entry('unchanged', 'rev-1'),
      entry('metadata-only', 'rev-2', { historyReady: false }),
    ],
    cachedMetadata: new Map([
      ['unchanged', { revision: 'rev-1', historyReady: true }],
    ]),
    forceAll: true,
  });

  assert.deepEqual(plans.map((plan) => [plan.entry.sessionId, plan.reason]), [
    ['unchanged', 'forced'],
  ]);
});

test('prioritizes invalidated then active sessions', () => {
  const plans = planSessionCacheSync({
    manifest: [entry('remaining', '1'), entry('active', '1'), entry('invalidated', '1')],
    cachedMetadata: new Map([
      ['remaining', { revision: '0', historyReady: true }],
      ['active', { revision: '0', historyReady: true }],
      ['invalidated', { revision: '1', historyReady: true }],
    ]),
    invalidatedSessionIds: new Set(['invalidated']),
    activeSessionId: 'active',
  });

  assert.deepEqual(plans.map((plan) => plan.entry.sessionId), ['invalidated', 'active', 'remaining']);
});

test('parses authoritative manifests and rejects malformed or duplicate rows', () => {
  assert.deepEqual(parseSessionCacheManifest([{ ...entry('b', '2'), isArchived: true }, entry('a', '1')]), [
    entry('a', '1'),
    entry('b', '2', { archived: true }),
  ]);
  assert.equal(parseSessionCacheManifest([entry('same', '1'), entry('same', '2')]), null);
  assert.equal(parseSessionCacheManifest([{ ...entry('invalid', '1'), historyReady: 'yes' }]), null);
});

test('filters control and streaming events while preserving normalized visible messages', () => {
  const message = getPersistableMessageEvent(event()) as NormalizedMessage;
  assert.equal(message.kind, 'text');
  assert.equal(message.sessionId, 'session-1');
  for (const kind of ['complete', 'status', 'permission_request', 'permission_cancelled', 'stream_delta', 'stream_end', 'session_upserted']) {
    assert.equal(getPersistableMessageEvent(event({ kind })), null, kind);
  }
  assert.equal(getPersistableMessageEvent(event({ sessionId: undefined }), { fallbackSessionId: 'fallback' })?.sessionId, 'fallback');
  assert.equal(getPersistableMessageEvent(event({ kind: 'unknown_protocol_frame' })), null);
});

test('runs work with bounded concurrency', async () => {
  let running = 0;
  let maximum = 0;
  const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    running++;
    maximum = Math.max(maximum, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running--;
    return value * 2;
  });

  assert.equal(maximum, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
});

test('deduplicates concurrent session synchronization and only cleans after a valid manifest', async () => {
  const synchronized: string[] = [];
  const cleaned: string[][] = [];
  let resolveManifest: (value: readonly SessionCacheManifestEntry[]) => void = () => undefined;
  const coordinator = new SessionCacheSyncCoordinator({
    fetchManifest: () => new Promise((resolve) => { resolveManifest = resolve; }),
    getCachedMetadata: async () => null,
    synchronizeSession: async (sessionId) => {
      synchronized.push(sessionId);
    },
    recordSessionMetadata: async () => undefined,
    cleanupCache: async (manifest) => { cleaned.push(manifest.map((item) => item.sessionId)); },
    getActiveSessionId: () => null,
    concurrency: 2,
  });

  const first = coordinator.reconcile();
  const second = coordinator.reconcile();
  assert.equal(first, second);
  assert.deepEqual(cleaned, []);
  resolveManifest([entry('one', '1'), entry('two', '1')]);
  await first;
  assert.deepEqual(cleaned, [['one', 'two']]);
  assert.deepEqual(synchronized.sort(), ['one', 'two']);
});

test('force sync records metadata-only sessions and reports partial failures', async () => {
  const synchronized: string[] = [];
  const metadata: string[] = [];
  const coordinator = new SessionCacheSyncCoordinator({
    fetchManifest: async () => [
      entry('unchanged', 'same'),
      entry('archived', 'old', { archived: true }),
      entry('no-history', 'none', { historyReady: false }),
    ],
    getCachedMetadata: async () => ({ revision: 'same', historyReady: true }),
    synchronizeSession: async (sessionId) => {
      synchronized.push(sessionId);
      if (sessionId === 'archived') return { status: 'error' };
      return { status: 'ok' };
    },
    recordSessionMetadata: async (sessionId) => {
      metadata.push(sessionId);
      return true;
    },
    cleanupCache: async () => undefined,
    getActiveSessionId: () => null,
    concurrency: 2,
  });

  const result = await coordinator.forceSync();
  assert.deepEqual(synchronized.sort(), ['archived', 'unchanged']);
  assert.deepEqual(metadata, ['no-history']);
  assert.deepEqual(result, {
    eligible: 2,
    succeeded: 1,
    failed: 1,
    success: false,
    manifestValid: true,
  });
});

test('uses distinct bounded concurrency for automatic and manual synchronization', async () => {
  const manifest = Array.from({ length: 12 }, (_, index) => entry(`session-${index}`, String(index)));
  const run = async (mode: 'automatic' | 'manual') => {
    let running = 0;
    let maximum = 0;
    let metadataLookups = 0;
    const coordinator = new SessionCacheSyncCoordinator({
      fetchManifest: async () => manifest,
      getCachedMetadata: async () => {
        metadataLookups++;
        return null;
      },
      synchronizeSession: async () => {
        running++;
        maximum = Math.max(maximum, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
        return { status: 'ok' };
      },
      recordSessionMetadata: async () => true,
      cleanupCache: async () => undefined,
      getActiveSessionId: () => null,
      automaticConcurrency: AUTOMATIC_CACHE_SYNC_CONCURRENCY,
      manualConcurrency: MANUAL_CACHE_SYNC_CONCURRENCY,
    });

    const result = mode === 'manual' ? await coordinator.forceSync() : await coordinator.reconcile();
    return { maximum, metadataLookups, result };
  };

  const automatic = await run('automatic');
  const manual = await run('manual');

  assert.equal(automatic.maximum, AUTOMATIC_CACHE_SYNC_CONCURRENCY);
  assert.equal(manual.maximum, MANUAL_CACHE_SYNC_CONCURRENCY);
  assert.ok(manual.maximum > automatic.maximum);
  assert.equal(manual.metadataLookups, 0);
  assert.equal(automatic.result, true);
  assert.deepEqual(manual.result, {
    eligible: manifest.length,
    succeeded: manifest.length,
    failed: 0,
    success: true,
    manifestValid: true,
  });
});

test('force sync does not read cached metadata while preserving one sync per transcript', async () => {
  const manifest = [entry('session-1', 'rev-1'), entry('session-2', 'rev-2')];
  let metadataLookups = 0;
  let authoritativePersistCalls = 0;
  const synchronized: string[] = [];
  const coordinator = new SessionCacheSyncCoordinator({
    fetchManifest: async () => manifest,
    getCachedMetadata: async () => {
      metadataLookups++;
      throw new Error('force planning should not read metadata');
    },
    synchronizeSession: async (sessionId) => {
      synchronized.push(sessionId);
      // The store's complete-history synchronizer owns one replacement per
      // successful transcript; the coordinator must invoke it only once.
      authoritativePersistCalls++;
      return { status: 'ok' };
    },
    recordSessionMetadata: async () => true,
    cleanupCache: async () => undefined,
    getActiveSessionId: () => null,
    manualConcurrency: 8,
  });

  const result = await coordinator.forceSync();

  assert.equal(metadataLookups, 0);
  assert.deepEqual(synchronized.sort(), ['session-1', 'session-2']);
  assert.equal(authoritativePersistCalls, manifest.length);
  assert.equal(result.succeeded, manifest.length);
});

test('invalidates a session so a later manifest sync does not trust its old revision', async () => {
  const synchronized: string[] = [];
  const coordinator = new SessionCacheSyncCoordinator({
    fetchManifest: async () => [entry('session-1', 'rev-1')],
    getCachedMetadata: async () => ({ revision: 'rev-1', historyReady: true }),
    synchronizeSession: async (sessionId) => { synchronized.push(sessionId); },
    recordSessionMetadata: async () => undefined,
    cleanupCache: async () => undefined,
    getActiveSessionId: () => null,
  });

  await coordinator.reconcile();
  coordinator.invalidateSession('session-1');
  await coordinator.reconcile();
  assert.deepEqual(synchronized, ['session-1']);
});

test('failed manifest does not clean the existing cache', async () => {
  let cleaned = 0;
  const coordinator = new SessionCacheSyncCoordinator({
    fetchManifest: async () => null,
    getCachedMetadata: async () => null,
    synchronizeSession: async () => undefined,
    recordSessionMetadata: async () => undefined,
    cleanupCache: async () => { cleaned++; },
    getActiveSessionId: () => null,
  });

  assert.equal(await coordinator.reconcile(), false);
  assert.equal(cleaned, 0);
});

test('serializes clear after synchronization and prevents stale writes after clear', async () => {
  const writes: string[] = [];
  let releaseSync: (() => void) | undefined;
  let cacheRows = 1;
  const coordinator = new SessionCacheSyncCoordinator({
    fetchManifest: async () => [entry('session-1', 'rev-1')],
    getCachedMetadata: async () => null,
    synchronizeSession: async () => {
      await new Promise<void>((resolve) => { releaseSync = resolve; });
      writes.push('sync');
      cacheRows = 2;
    },
    recordSessionMetadata: async () => undefined,
    cleanupCache: async () => undefined,
    getActiveSessionId: () => null,
    clearCache: async () => {
      cacheRows = 0;
      return true;
    },
    waitForCacheWrites: async () => undefined,
    getCacheStats: async () => ({ sessionCount: cacheRows, messageCount: cacheRows }),
    beginCacheClear: () => { writes.push('block'); },
    endCacheClear: () => { writes.push('unblock'); },
  });

  const sync = coordinator.reconcile();
  const clear = coordinator.clearCache();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, []);
  releaseSync?.();
  await sync;
  assert.deepEqual(await clear, {
    success: true,
    stats: { sessionCount: 0, messageCount: 0 },
  });
  assert.deepEqual(writes, ['sync', 'block', 'unblock']);
});

test('reports clear failure when the repository returns false', async () => {
  const coordinator = new SessionCacheSyncCoordinator({
    fetchManifest: async () => [],
    getCachedMetadata: async () => null,
    synchronizeSession: async () => undefined,
    recordSessionMetadata: async () => undefined,
    cleanupCache: async () => undefined,
    getActiveSessionId: () => null,
    clearCache: async () => false,
    getCacheStats: async () => ({ sessionCount: 2, messageCount: 4 }),
  });

  assert.deepEqual(await coordinator.clearCache(), {
    success: false,
    stats: { sessionCount: 2, messageCount: 4 },
  });
});

test('reports clear failure when the repository throws', async () => {
  const coordinator = new SessionCacheSyncCoordinator({
    fetchManifest: async () => [],
    getCachedMetadata: async () => null,
    synchronizeSession: async () => undefined,
    recordSessionMetadata: async () => undefined,
    cleanupCache: async () => undefined,
    getActiveSessionId: () => null,
    clearCache: async () => { throw new Error('transaction failed'); },
    getCacheStats: async () => ({ sessionCount: 1, messageCount: 3 }),
  });

  assert.deepEqual(await coordinator.clearCache(), {
    success: false,
    stats: { sessionCount: 1, messageCount: 3 },
  });
});

test('reports clear failure when post-clear stats are non-zero', async () => {
  const coordinator = new SessionCacheSyncCoordinator({
    fetchManifest: async () => [],
    getCachedMetadata: async () => null,
    synchronizeSession: async () => undefined,
    recordSessionMetadata: async () => undefined,
    cleanupCache: async () => undefined,
    getActiveSessionId: () => null,
    clearCache: async () => true,
    getCacheStats: async () => ({ sessionCount: 1, messageCount: 0 }),
  });

  assert.deepEqual(await coordinator.clearCache(), {
    success: false,
    stats: { sessionCount: 1, messageCount: 0 },
  });
});

test('reports clear success only when the repository succeeds and post-clear stats are zero', async () => {
  const coordinator = new SessionCacheSyncCoordinator({
    fetchManifest: async () => [],
    getCachedMetadata: async () => null,
    synchronizeSession: async () => undefined,
    recordSessionMetadata: async () => undefined,
    cleanupCache: async () => undefined,
    getActiveSessionId: () => null,
    clearCache: async () => true,
    getCacheStats: async () => ({ sessionCount: 0, messageCount: 0 }),
  });

  assert.deepEqual(await coordinator.clearCache(), {
    success: true,
    stats: { sessionCount: 0, messageCount: 0 },
  });
});

test('hidden or offline states pause scheduled work', () => {
  assert.equal(canRunSessionCacheSync('hidden', true), false);
  assert.equal(canRunSessionCacheSync('visible', false), false);
  assert.equal(canRunSessionCacheSync('visible', true), true);
});
