import assert from 'node:assert/strict';
import test from 'node:test';

import { evictInactiveSessionSlots, MAX_IN_MEMORY_SESSION_SLOTS, type SessionSlot } from './useSessionStore';

function slot(overrides: Partial<SessionSlot> = {}): SessionSlot {
  return {
    serverMessages: [], realtimeMessages: [], merged: [], _lastServerRef: [], _lastRealtimeRef: [],
    _fetchSeq: 0, _appliedFetchSeq: 0, _cacheHydrationSeq: 0, _appliedCacheHydrationSeq: 0,
    _cacheHydrationStarted: false, _cacheHydrationInFlight: null, _canonicalFetchInFlight: null,
    status: 'idle', fetchedAt: 0, total: 0, hasMore: false, offset: 0, tokenUsage: null,
    realtimeCursor: null, realtimeStream: null, recoveryInFlight: null, viewRevision: 0,
    canonicalRevision: null, ...overrides,
  };
}

test('inactive LRU remains bounded and protects active, processing, unreconciled, and in-flight slots', () => {
  const store = new Map<string, SessionSlot>();
  const used = new Map<string, number>();
  for (let index = 0; index < MAX_IN_MEMORY_SESSION_SLOTS + 5; index++) {
    store.set(`idle-${index}`, slot()); used.set(`idle-${index}`, index);
  }
  store.set('active', slot()); used.set('active', -4);
  store.set('processing', slot({ status: 'streaming' })); used.set('processing', -3);
  store.set('unsent', slot({ realtimeMessages: [{ id: 'u', sessionId: 'unsent', timestamp: '2026-01-01', provider: 'claude', kind: 'text', role: 'user' }] })); used.set('unsent', -2);
  store.set('in-flight', slot({ _canonicalFetchInFlight: Promise.resolve(slot()) })); used.set('in-flight', -1);
  evictInactiveSessionSlots(store, used, 'active');
  assert.ok(store.size >= MAX_IN_MEMORY_SESSION_SLOTS);
  assert.ok(store.has('active')); assert.ok(store.has('processing')); assert.ok(store.has('unsent')); assert.ok(store.has('in-flight'));
  assert.equal(store.has('idle-0'), false);
});
