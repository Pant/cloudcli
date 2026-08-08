import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './normalizedMessage';
import {
  acceptSequencedEvent,
  deduplicateMessagesById,
  reduceRealtimeStream,
  shouldApplyCacheHydration,
  upsertMessageById,
} from './sessionStore.helpers';

const message = (id: string, content = id): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content,
});

test('idempotent realtime upsert replaces a duplicate message id once', () => {
  const first = message('realtime-1', 'partial');
  const final = message('realtime-1', 'final');

  const result = upsertMessageById(upsertMessageById([], first), final);

  assert.deepEqual(result, [final]);
  assert.deepEqual(deduplicateMessagesById([...result, final]).map((row) => row.id), ['realtime-1']);
});

test('cache hydration is rejected after a newer authoritative fetch applies', () => {
  assert.equal(shouldApplyCacheHydration({
    hydrationGeneration: 1,
    currentGeneration: 1,
    hydrationTicket: 1,
    currentHydrationTicket: 1,
    appliedFetchTicket: 0,
  }), true);

  assert.equal(shouldApplyCacheHydration({
    hydrationGeneration: 1,
    currentGeneration: 1,
    hydrationTicket: 1,
    currentHydrationTicket: 1,
    appliedFetchTicket: 2,
  }), false);
});

test('cache hydration is rejected after an authenticated user namespace changes', () => {
  assert.equal(shouldApplyCacheHydration({
    hydrationGeneration: 1,
    currentGeneration: 2,
    hydrationTicket: 1,
    currentHydrationTicket: 1,
    appliedFetchTicket: 0,
  }), false);
});

test('generation cursor rejects duplicates and stale generations and detects holes', () => {
  assert.equal(acceptSequencedEvent({ generation: 4, seq: 3 }, 4, 3).status, 'duplicate');
  assert.equal(acceptSequencedEvent({ generation: 4, seq: 3 }, 3, 10).status, 'stale_generation');
  assert.deepEqual(acceptSequencedEvent({ generation: 4, seq: 3 }, 4, 5), {
    status: 'gap', cursor: { generation: 4, seq: 3 }, expectedSeq: 4,
  });
});

test('new generation starts at one and intentionally rolls the cursor', () => {
  assert.deepEqual(acceptSequencedEvent({ generation: 4, seq: 9 }, 5, 1), {
    status: 'accepted', cursor: { generation: 5, seq: 1 }, generationChanged: true,
  });
  assert.equal(acceptSequencedEvent({ generation: 4, seq: 9 }, 5, 2).status, 'gap');
});

test('two stream reducers interleave independently and finalize only matching generation', () => {
  const delta = (generation: number, content: string) => ({
    kind: 'stream_delta' as const, generation, content, timestamp: '2026-01-01T00:00:00.000Z',
  });
  let a = reduceRealtimeStream(null, delta(1, 'A'));
  let b = reduceRealtimeStream(null, delta(8, 'B'));
  a = reduceRealtimeStream(a, delta(1, '1'));
  b = reduceRealtimeStream(b, delta(8, '2'));
  assert.equal(a?.content, 'A1');
  assert.equal(b?.content, 'B2');
  assert.equal(reduceRealtimeStream(a, { kind: 'stream_end', generation: 2, timestamp: '', content: '' })?.content, 'A1');
  assert.equal(reduceRealtimeStream(a, { kind: 'complete', generation: 1, timestamp: '', content: '' }), null);
});
