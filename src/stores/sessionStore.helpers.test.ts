import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './normalizedMessage';
import {
  acceptSequencedEvent,
  acceptCanonicalRevision,
  canReuseNotModified,
  deduplicateMessagesById,
  finalizeRealtimeStreamMessage,
  getSessionWarmupPolicy,
  getCanonicalResponseMetadataSnapshot,
  hasCompleteCanonicalSnapshot,
  isCanonicalResponseMetadataReady,
  materializeRealtimeStream,
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

const openCodeMessage = (
  id: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  ...message(id),
  provider: 'opencode',
  ...overrides,
});

const responseMetadata = (inputTokens: number, outputTokens = 2) => ({
  inputTokens,
  outputTokens,
  timestamp: `2026-01-01T00:00:0${inputTokens}.000Z`,
});

test('opaque canonical revisions use equality plus fetch-ticket freshness', () => {
  assert.equal(acceptCanonicalRevision('rev-new', 'rev-old', true), 'reject');
  assert.equal(acceptCanonicalRevision('rev-1', 'rev-1', false), 'same');
  assert.equal(acceptCanonicalRevision('rev-1', 'rev-2', false), 'accept');
  assert.equal(canReuseNotModified('rev-1', 'rev-1'), true);
  assert.equal(canReuseNotModified(null, 'rev-1'), false);
  assert.equal(canReuseNotModified('rev-2', 'rev-1'), false);
});

test('conditional history reuse requires a complete canonical row set', () => {
  assert.equal(hasCompleteCanonicalSnapshot({
    canonicalRevision: 'rev-1', serverMessageCount: 2, total: 2, hasMore: false, offset: 2,
  }), true);
  assert.equal(hasCompleteCanonicalSnapshot({
    canonicalRevision: 'rev-1', serverMessageCount: 1, total: 2, hasMore: false, offset: 1,
  }), false);
  assert.equal(hasCompleteCanonicalSnapshot({
    canonicalRevision: 'rev-1', serverMessageCount: 2, total: 2, hasMore: true, offset: 2,
  }), false);
  assert.equal(hasCompleteCanonicalSnapshot({
    canonicalRevision: null, serverMessageCount: 0, total: 0, hasMore: false, offset: 0,
  }), false);
});

test('warm-up reuses a fresh complete slot without canonical loading', () => {
  assert.deepEqual(getSessionWarmupPolicy({
    hasCompleteSnapshot: true,
    fetchedAt: 90_000,
    now: 100_000,
    staleThresholdMs: 30_000,
    messageCount: 2,
  }), {
    reuseFreshSnapshot: true,
    hasDisplayableMessages: true,
    requiresCanonicalFetch: false,
  });
});

test('warm-up exposes cached rows while requiring stale canonical validation', () => {
  assert.deepEqual(getSessionWarmupPolicy({
    hasCompleteSnapshot: true,
    fetchedAt: 0,
    now: 100_000,
    staleThresholdMs: 30_000,
    messageCount: 2,
  }), {
    reuseFreshSnapshot: false,
    hasDisplayableMessages: true,
    requiresCanonicalFetch: true,
  });
  assert.equal(getSessionWarmupPolicy({
    hasCompleteSnapshot: false,
    fetchedAt: 0,
    now: 100_000,
    staleThresholdMs: 30_000,
    messageCount: 0,
  }).hasDisplayableMessages, false);
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
  a = materializeRealtimeStream(a!);
  b = materializeRealtimeStream(b!);
  assert.equal(a?.content, 'A1');
  assert.equal(b?.content, 'B2');
  assert.equal(reduceRealtimeStream(a, { kind: 'stream_end', generation: 2, timestamp: '', content: '' })?.content, 'A1');
  assert.equal(reduceRealtimeStream(a, { kind: 'complete', generation: 1, timestamp: '', content: '' }), null);
});

test('high-volume stream acceptance accumulates chunks without per-delta text copies', () => {
  let stream = null;
  let cursor = null;
  const accepted = 10_000;
  for (let seq = 1; seq <= accepted; seq++) {
    const acceptance = acceptSequencedEvent(cursor, 1, seq);
    assert.equal(acceptance.status, 'accepted');
    if (acceptance.status !== 'accepted') continue;
    cursor = acceptance.cursor;
    stream = reduceRealtimeStream(stream, {
      kind: 'stream_delta', generation: 1, content: String(seq % 10), timestamp: '2026-01-01T00:00:00.000Z',
    });
  }
  assert.equal(cursor?.seq, accepted);
  assert.equal(stream?.content.length, accepted);
  assert.equal(stream?.pendingChunks?.length, accepted);
  const committed = materializeRealtimeStream(stream!);
  assert.equal(committed.content, Array.from({ length: accepted }, (_, index) => String((index + 1) % 10)).join(''));
  assert.equal(committed.pendingChunks?.length, 0);
});

test('materialized streams roll generations and remain independent', () => {
  const delta = (generation: number, content: string) => ({
    kind: 'stream_delta' as const, generation, content, timestamp: '2026-01-01T00:00:00.000Z',
  });
  const a = materializeRealtimeStream(reduceRealtimeStream(reduceRealtimeStream(null, delta(1, 'a'))!, delta(1, '1'))!);
  const b = materializeRealtimeStream(reduceRealtimeStream(reduceRealtimeStream(null, delta(8, 'b'))!, delta(8, '2'))!);
  const rollover = materializeRealtimeStream(reduceRealtimeStream(a, delta(2, 'new'))!);
  assert.equal(a.content, 'a1');
  assert.equal(b.content, 'b2');
  assert.equal(rollover.content, 'new');
});

test('terminal response metadata is retained when a realtime stream becomes assistant text', () => {
  const stream = openCodeMessage('stream', { kind: 'stream_delta', content: 'Answer' });
  const metadata = responseMetadata(7, 3);
  const terminal = openCodeMessage('terminal', { kind: 'stream_end', responseMetadata: metadata });

  assert.deepEqual(finalizeRealtimeStreamMessage(stream, terminal), {
    ...stream,
    kind: 'text',
    role: 'assistant',
    responseMetadata: metadata,
  });
});

test('metadata-free terminal events do not erase metadata already present on a stream row', () => {
  const metadata = responseMetadata(4, 2);
  const stream = openCodeMessage('stream', {
    kind: 'stream_delta',
    content: 'Answer',
    responseMetadata: metadata,
  });
  const terminal = openCodeMessage('terminal', { kind: 'complete' });

  assert.equal(finalizeRealtimeStreamMessage(stream, terminal).responseMetadata, metadata);
});

test('canonical metadata inspection supports text, thinking, and tool-only OpenCode responses', () => {
  const rows = [
    openCodeMessage('text', { responseMetadata: responseMetadata(1) }),
    openCodeMessage('thinking', { kind: 'thinking', role: undefined, responseMetadata: responseMetadata(2) }),
    openCodeMessage('tool', { kind: 'tool_use', role: undefined, responseMetadata: responseMetadata(3) }),
  ];

  const snapshot = getCanonicalResponseMetadataSnapshot(rows);
  assert.equal(snapshot.count, 3);
  assert.equal(snapshot.latestResponseHasMetadata, true);
  assert.match(snapshot.signature, /text/);
  assert.match(snapshot.signature, /thinking/);
  assert.match(snapshot.signature, /tool/);
});

test('control and error trailing rows do not replace the latest renderable response', () => {
  const snapshot = getCanonicalResponseMetadataSnapshot([
    openCodeMessage('answer', { responseMetadata: responseMetadata(1) }),
    openCodeMessage('stream-end', { kind: 'stream_end', role: undefined }),
    openCodeMessage('error', { kind: 'error', role: undefined }),
    openCodeMessage('status', { kind: 'status', role: undefined }),
  ]);

  assert.equal(snapshot.latestResponseHasMetadata, true);
  assert.equal(snapshot.count, 1);
});

test('older metadata does not make a latest unhydrated response ready', () => {
  const baseline = getCanonicalResponseMetadataSnapshot([]);
  const current = getCanonicalResponseMetadataSnapshot([
    openCodeMessage('older', { responseMetadata: responseMetadata(1) }),
    openCodeMessage('latest'),
  ]);

  assert.equal(current.latestResponseHasMetadata, false);
  assert.equal(isCanonicalResponseMetadataReady(baseline, current), false);
});

test('latest metadata is ready only when the metadata baseline changes', () => {
  const older = openCodeMessage('older', { responseMetadata: responseMetadata(1) });
  const baseline = getCanonicalResponseMetadataSnapshot([older]);
  const unchanged = getCanonicalResponseMetadataSnapshot([older]);
  const current = getCanonicalResponseMetadataSnapshot([
    older,
    openCodeMessage('latest', { kind: 'tool_use', role: undefined, responseMetadata: responseMetadata(2) }),
  ]);

  assert.equal(isCanonicalResponseMetadataReady(baseline, unchanged), false);
  assert.equal(isCanonicalResponseMetadataReady(baseline, current), true);
});

test('non-OpenCode rows are excluded from metadata count and signature', () => {
  const claude = message('claude');
  claude.responseMetadata = responseMetadata(1);
  const snapshot = getCanonicalResponseMetadataSnapshot([
    claude,
    openCodeMessage('user', { role: 'user', responseMetadata: responseMetadata(2) }),
    openCodeMessage('tool-result', { kind: 'tool_result', role: undefined, responseMetadata: responseMetadata(3) }),
  ]);

  assert.deepEqual(snapshot, { count: 0, signature: '', latestResponseHasMetadata: false });
});

test('metadata signature detects replacement even when the count is unchanged', () => {
  const baseline = getCanonicalResponseMetadataSnapshot([
    openCodeMessage('response', { responseMetadata: responseMetadata(1) }),
  ]);
  const current = getCanonicalResponseMetadataSnapshot([
    openCodeMessage('response', { responseMetadata: responseMetadata(4) }),
  ]);

  assert.equal(current.count, baseline.count);
  assert.notEqual(current.signature, baseline.signature);
  assert.equal(isCanonicalResponseMetadataReady(baseline, current), true);
});
