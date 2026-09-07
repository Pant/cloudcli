/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import { apiClient } from '../utils/apiClient';
import { incrementDiagnosticMetric, logDiagnostic } from '../lib/logger';
import { KeyedServerState } from '../lib/serverState';
import type { LLMProvider } from '../types/app';

import {
  SessionMessageCacheRepository,
  type CacheStats,
  type CacheStorageStatus,
  cacheStorageStatusesMatch,
  EMPTY_CACHE_STORAGE_STATUS,
  inspectBrowserStorage,
  type CacheRevision,
  type SessionManifestEntry,
  type SessionSyncMetadata,
} from './sessionMessageCache';
import {
  AUTOMATIC_CACHE_SYNC_CONCURRENCY,
  MANUAL_CACHE_SYNC_CONCURRENCY,
  parseSessionCacheManifest,
  SessionCacheSyncCoordinator,
  type SessionCacheManifestEntry,
} from './sessionMessageCacheCoordinator';
import {
  acceptSequencedEvent,
  canReuseNotModified,
  DEFAULT_REALTIME_COMMIT_INTERVAL_MS,
  deduplicateMessagesById,
  finalizeRealtimeStreamMessage,
  getSessionWarmupPolicy,
  getCanonicalResponseMetadataSnapshot,
  hasCompleteCanonicalSnapshot,
  isCanonicalResponseMetadataReady,
  materializeRealtimeStream,
  reduceRealtimeStream,
  shouldScheduleRealtimeStreamCommit,
  shouldApplyCacheHydration,
  upsertMessageById,
  type RealtimeCursor,
  type RealtimeStreamState,
  type CanonicalResponseMetadataSnapshot,
} from './sessionStore.helpers';
import { removeOptimisticUserEchoes } from './sessionMessageReconciliation';
export type { MessageKind, NormalizedMessage } from './normalizedMessage';
import type { NormalizedMessage } from './normalizedMessage';

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  /**
   * @internal Monotonic ticket per server fetch (fetch/refresh/fetchMore) and
   * the ticket of the last response applied. Concurrent fetches for the same
   * session can resolve out of order — e.g. the `complete` refresh racing the
   * watcher-triggered refresh right as a queued message is flushed — and a
   * stale response applied last would wind `serverMessages` back to a
   * transcript that no longer matches what the user already saw.
   */
  _fetchSeq: number;
  _appliedFetchSeq: number;
  /** @internal Cache hydration sequencing, separate from server fetch tickets. */
  _cacheHydrationSeq: number;
  _appliedCacheHydrationSeq: number;
  _cacheHydrationStarted: boolean;
  _cacheHydrationInFlight: Promise<SessionSlot> | null;
  _canonicalFetchInFlight: Promise<SessionSlot> | null;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
  realtimeCursor: RealtimeCursor | null;
  realtimeStream: RealtimeStreamState | null;
  recoveryInFlight: Promise<void> | null;
  /** Monotonic view revision for any visible content or metadata mutation. */
  viewRevision: number;
  canonicalRevision: string | null;
}

export interface SessionSnapshot {
  messages: NormalizedMessage[];
  status: SessionStatus;
  total: number;
  hasMore: boolean;
  fetchedAt: number;
  offset: number;
  tokenUsage: unknown;
  revision: number;
  canonicalRevision: string | null;
  hasDisplayableMessages: boolean;
  isCanonicalLoading: boolean;
}

const EMPTY: NormalizedMessage[] = [];

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    _fetchSeq: 0,
    _appliedFetchSeq: 0,
    _cacheHydrationSeq: 0,
    _appliedCacheHydrationSeq: 0,
    _cacheHydrationStarted: false,
    _cacheHydrationInFlight: null,
    _canonicalFetchInFlight: null,
    realtimeCursor: null,
    realtimeStream: null,
    recoveryInFlight: null,
    viewRevision: 0,
    canonicalRevision: null,
  };
}

function bumpViewRevision(slot: SessionSlot): void {
  slot.viewRevision += 1;
}

export interface SessionStoreOptions {
  /** Authenticated browser-cache namespace. Omit to disable persistence. */
  userNamespace?: string | null;
  /** Injectable repository for tests/embedders; defaults to the browser cache. */
  cache?: SessionMessageCacheRepository | null;
  /** Visible stream/cache commit cadence. Injectable for deterministic tests. */
  realtimeCommitIntervalMs?: number;
}

export interface CompleteSessionSyncOptions {
  revision?: CacheRevision;
  fetchedAt?: number | string | null;
  [key: string]: unknown;
}

export interface RefreshFromServerOptions {
  /** Start a new canonical request, aborting/fencing any older keyed request. */
  force?: boolean;
}

/**
 * Compute merged messages: server + realtime, deduped by id and adjacent
 * assistant echo (same trimmed text), so finalized stream rows do not stack
 * on top of the persisted copy before realtime is cleared.
 */
function readMessageTime(m: NormalizedMessage): number | null {
  const time = Date.parse(m.timestamp);
  return Number.isFinite(time) ? time : null;
}

function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

/**
 * Count how many user turns precede `message` in a chronologically merged view
 * of server + realtime rows. Used to match a realtime row to the correct turn
 * on disk when several turns share identical assistant text.
 */
function getUserTurnOrdinalBefore(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): number {
  const messageTime = readMessageTime(message);
  let userCount = 0;

  for (const candidate of [...serverMessages, ...realtimeMessages].sort(compareMessagesChronologically)) {
    if (candidate.id === message.id) {
      break;
    }

    const candidateTime = readMessageTime(candidate);
    if (
      messageTime !== null
      && candidateTime !== null
      && candidateTime > messageTime
    ) {
      break;
    }

    if (candidate.kind === 'text' && candidate.role === 'user') {
      userCount++;
    }
  }

  return Math.max(0, userCount - 1);
}

function findServerTurnRangeByOrdinal(
  serverMessages: NormalizedMessage[],
  turnOrdinal: number,
): { start: number; end: number } | null {
  let userCount = -1;
  let start = -1;

  for (let index = 0; index < serverMessages.length; index++) {
    const message = serverMessages[index];
    if (message.kind === 'text' && message.role === 'user') {
      userCount++;
      if (userCount === turnOrdinal) {
        start = index;
        break;
      }
    }
  }

  if (start < 0) {
    return null;
  }

  let end = serverMessages.length;
  for (let index = start + 1; index < serverMessages.length; index++) {
    if (serverMessages[index].kind === 'text' && serverMessages[index].role === 'user') {
      end = index;
      break;
    }
  }

  return { start, end };
}

function isAssistantTextEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): boolean {
  const assistantText = (message.content || '').trim();
  if (!assistantText) {
    return false;
  }

  const turnOrdinal = getUserTurnOrdinalBefore(message, serverMessages, realtimeMessages);
  const turnRange = findServerTurnRangeByOrdinal(serverMessages, turnOrdinal);
  if (!turnRange) {
    return false;
  }

  return serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .some((serverMessage) =>
      serverMessage.kind === 'text'
      && serverMessage.role === 'assistant'
      && (serverMessage.content || '').trim() === assistantText,
    );
}

/**
 * After `finalizeStreaming`, the client holds a synthetic assistant `text` row
 * while the sessions API soon returns the same reply with a different id.
 * Those sit back-to-back in merged order and look like duplicate bubbles until
 * `refreshFromServer` clears realtime. Collapse same-text assistant rows and
 * stream_placeholder → text when content matches.
 */
function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of merged) {
    const prev = out[out.length - 1];
    if (prev) {
      if (prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[out.length - 1] = m;
          continue;
        }
      }
      if (
        prev.kind === 'text'
        && m.kind === 'text'
        && prev.role === 'assistant'
        && m.role === 'assistant'
      ) {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) {
          continue;
        }
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * After a server refresh, drop only the realtime rows the persisted transcript
 * already owns. Anything not yet on disk (common right after `complete`, while
 * JSONL indexing lags) stays in `realtimeMessages` so the chat pane never
 * flashes the empty "Continue your conversation" state.
 */
function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const reconciledRealtimeMessages = removeOptimisticUserEchoes(serverMessages, realtimeMessages);

  return reconciledRealtimeMessages.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }

    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return true;
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });
}

function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }
  if (server.length === 0) {
    return dedupeAdjacentAssistantEchoes(realtime);
  }

  const serverIds = new Set(server.map((message) => message.id));
  const reconciledRealtime = removeOptimisticUserEchoes(server, realtime);
  const extra = reconciledRealtime.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }
    return true;
  });

  if (extra.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }

  // Interleave by timestamp so live rows stay with their turn instead of
  // piling up at the bottom after every refresh.
  return dedupeAdjacentAssistantEchoes(
    [...server, ...extra].sort(compareMessagesChronologically),
  );
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;
export const MAX_IN_MEMORY_SESSION_SLOTS = 20;

export function evictInactiveSessionSlots(
  store: Map<string, SessionSlot>,
  lastUsed: Map<string, number>,
  activeSessionId: string | null,
  limit = MAX_IN_MEMORY_SESSION_SLOTS,
): string[] {
  const removed: string[] = [];
  if (store.size <= limit) return removed;
  const candidates = [...store.entries()]
    .filter(([id, slot]) => id !== activeSessionId
      && slot.status === 'idle'
      && slot.realtimeMessages.length === 0
      && !slot.realtimeStream
      && !slot._cacheHydrationInFlight
      && !slot._canonicalFetchInFlight
      && !slot.recoveryInFlight)
    .sort(([a], [b]) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0));
  for (const [id] of candidates) {
    if (store.size <= limit) break;
    store.delete(id); lastUsed.delete(id); removed.push(id);
  }
  return removed;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore(options: SessionStoreOptions = {}) {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const snapshotRef = useRef(new Map<string, SessionSnapshot>());
  const activeSessionIdRef = useRef<string | null>(null);
  const isChatSurfaceActiveRef = useRef(false);
  const sessionLastUsedRef = useRef(new Map<string, number>());
  const initialNamespace = options.userNamespace ?? null;
  const userNamespaceRef = useRef<string | null>(initialNamespace);
  const storeGenerationRef = useRef(0);
  const cacheRef = useRef<SessionMessageCacheRepository | null>(null);
  const cacheWriteChainsRef = useRef(new Map<string, Promise<void>>());
  const cacheWritesBlockedRef = useRef(false);
  const cacheWriteEpochRef = useRef(0);
  const realtimeCommitTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const historyOwnerRef = useRef<KeyedServerState<string, Awaited<ReturnType<typeof apiClient.sessionHistory>>> | null>(null);
  if (!historyOwnerRef.current) {
    historyOwnerRef.current = new KeyedServerState((sessionId, signal) => apiClient.sessionHistory(sessionId, { signal }));
  }
  if (!cacheRef.current) {
    cacheRef.current = options.cache ?? new SessionMessageCacheRepository();
  }
  const cache = cacheRef.current;

  // Authenticated application providers stay mounted across navigation. A
  // user switch must still invalidate every in-memory slot immediately so a
  // late response/hydration from the previous namespace cannot be rendered.
  if (userNamespaceRef.current !== (options.userNamespace ?? null)) {
    userNamespaceRef.current = options.userNamespace ?? null;
    storeGenerationRef.current += 1;
    storeRef.current.clear();
    snapshotRef.current.clear();
    activeSessionIdRef.current = null;
  }

  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly with
  // no alias/redirect indirection.
  const [, setTick] = useState(0);
  const [cacheStorageStatus, setCacheStorageStatus] = useState<CacheStorageStatus>(EMPTY_CACHE_STORAGE_STATUS);
  const notify = useCallback((sessionId: string) => {
    if (isChatSurfaceActiveRef.current && sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const logCacheFailure = useCallback((operation: string, error: unknown) => {
    // Persistence is an optimization. Keep failures visible to developers but
    // never let them reject a network chat operation or surface in the UI.
    console.warn(`[SessionStore] cache ${operation} failed:`, error);
    incrementDiagnosticMetric('cacheFailure');
    logDiagnostic({ level: 'warn', area: 'session_store', event: 'cache_failed', outcome: 'fail_open', code: error instanceof Error ? error.name : 'CACHE_ERROR', metadata: { operation } });
  }, []);

  const enqueueCacheWrite = useCallback((
    sessionId: string,
    operation: () => Promise<unknown>,
    epoch = cacheWriteEpochRef.current,
  ) => {
    if (cacheWritesBlockedRef.current) return;
    const previous = cacheWriteChainsRef.current.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => {
        if (cacheWritesBlockedRef.current || epoch !== cacheWriteEpochRef.current) return undefined;
        return operation();
      })
      .catch((error) => logCacheFailure('write', error))
      .then(() => undefined);
    cacheWriteChainsRef.current.set(sessionId, next);
    void next.finally(() => {
      if (cacheWriteChainsRef.current.get(sessionId) === next) {
        cacheWriteChainsRef.current.delete(sessionId);
      }
    });
  }, [logCacheFailure]);

  const waitForCacheWrites = useCallback(async () => {
    await Promise.all([...cacheWriteChainsRef.current.values()]);
  }, []);

  const persistAuthoritativeSlot = useCallback((
    sessionId: string,
    slot: SessionSlot,
    metadata?: SessionSyncMetadata | null,
    epoch = cacheWriteEpochRef.current,
  ) => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return;
    enqueueCacheWrite(sessionId, () => cache.replaceAuthoritativeSession({
      userNamespace: namespace,
      sessionId,
      serverMessages: slot.serverMessages,
      unreconciledRealtimeMessages: slot.realtimeMessages,
      metadata: metadata ?? {
        fetchedAt: slot.fetchedAt,
        total: slot.total,
        hasMore: slot.hasMore,
        offset: slot.offset,
        canonicalRevision: slot.canonicalRevision,
      },
    }), epoch);
  }, [cache, enqueueCacheWrite]);

  const persistRealtimeMessage = useCallback((sessionId: string, message: NormalizedMessage) => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return;
    enqueueCacheWrite(sessionId, () => cache.upsertRealtimeMessage(namespace, sessionId, message));
  }, [cache, enqueueCacheWrite]);

  const commitRealtimeStream = useCallback((sessionId: string, options: { notify?: boolean; persist?: boolean } = {}) => {
    const timer = realtimeCommitTimersRef.current.get(sessionId);
    if (timer) clearTimeout(timer);
    realtimeCommitTimersRef.current.delete(sessionId);
    const slot = storeRef.current.get(sessionId);
    if (!slot?.realtimeStream) return;
    slot.realtimeStream = materializeRealtimeStream(slot.realtimeStream);
    const stream = slot.realtimeStream;
    const streamMessage: NormalizedMessage = {
      id: `__streaming_${sessionId}_${stream.generation}`,
      sessionId,
      provider: stream.provider ?? 'claude',
      kind: 'stream_delta',
      content: stream.content,
      timestamp: stream.startedAt,
    };
    const existing = slot.realtimeMessages.find((message) => message.id === streamMessage.id);
    slot.realtimeMessages = upsertMessageById(slot.realtimeMessages, existing ? { ...existing, ...streamMessage } : streamMessage);
    recomputeMergedIfNeeded(slot);
    bumpViewRevision(slot);
    if (options.persist !== false) {
      persistRealtimeMessage(sessionId, slot.realtimeMessages.find((message) => message.id === streamMessage.id)!);
    }
    if (options.notify !== false) notify(sessionId);
  }, [notify, persistRealtimeMessage]);

  const scheduleRealtimeStreamCommit = useCallback((sessionId: string) => {
    if (!shouldScheduleRealtimeStreamCommit({
      isChatSurfaceActive: isChatSurfaceActiveRef.current,
      isActiveSession: sessionId === activeSessionIdRef.current,
      hasScheduledCommit: realtimeCommitTimersRef.current.has(sessionId),
    })) return;
    const interval = Math.max(0, options.realtimeCommitIntervalMs ?? DEFAULT_REALTIME_COMMIT_INTERVAL_MS);
    realtimeCommitTimersRef.current.set(sessionId, setTimeout(() => commitRealtimeStream(sessionId), interval));
  }, [commitRealtimeStream, options.realtimeCommitIntervalMs]);

  const deleteCachedRealtimeMessage = useCallback((sessionId: string, messageId: string) => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return;
    enqueueCacheWrite(sessionId, () => cache.deleteRealtimeMessage(namespace, sessionId, messageId));
  }, [cache, enqueueCacheWrite]);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
    if (sessionId) {
      sessionLastUsedRef.current.set(sessionId, Date.now());
      if (isChatSurfaceActiveRef.current) commitRealtimeStream(sessionId);
    }
  }, [commitRealtimeStream]);

  const setChatSurfaceActive = useCallback((isActive: boolean) => {
    if (isChatSurfaceActiveRef.current === isActive) return;
    isChatSurfaceActiveRef.current = isActive;
    if (!isActive) {
      for (const timer of realtimeCommitTimersRef.current.values()) clearTimeout(timer);
      realtimeCommitTimersRef.current.clear();
      return;
    }
    const sessionId = activeSessionIdRef.current;
    if (sessionId) commitRealtimeStream(sessionId);
  }, [commitRealtimeStream]);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
    }
    sessionLastUsedRef.current.set(sessionId, Date.now());
    for (const evicted of evictInactiveSessionSlots(store, sessionLastUsedRef.current, activeSessionIdRef.current)) {
      snapshotRef.current.delete(evicted);
    }
    return store.get(sessionId)!;
  }, []);

  const hydrateFromCache = useCallback((sessionId: string): Promise<SessionSlot> => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return Promise.resolve(getSlot(sessionId));
    const slot = getSlot(sessionId);
    if (slot._cacheHydrationInFlight) return slot._cacheHydrationInFlight;
    if (slot._cacheHydrationStarted) return Promise.resolve(slot);
    slot._cacheHydrationStarted = true;
    const hydrationTicket = ++slot._cacheHydrationSeq;
    const generation = storeGenerationRef.current;
    const startedAt = Date.now();
    logDiagnostic({ level: 'info', area: 'session_store', event: 'cache_hydration_started', sessionId, generation });

    const hydration = (async () => {
    try {
      const hydrated = await cache.hydrateSession(namespace, sessionId);
      if (
        !hydrated
        || namespace !== userNamespaceRef.current
        || !shouldApplyCacheHydration({
          hydrationGeneration: generation,
          currentGeneration: storeGenerationRef.current,
          hydrationTicket,
          currentHydrationTicket: slot._cacheHydrationSeq,
          appliedFetchTicket: slot._appliedFetchSeq,
        })
      ) {
        logDiagnostic({ level: 'debug', area: 'session_store', event: 'cache_hydration_skipped', sessionId, generation, durationMs: Date.now() - startedAt, outcome: hydrated ? 'stale' : 'empty' });
        return slot;
      }

      slot._appliedCacheHydrationSeq = hydrationTicket;
      slot.serverMessages = deduplicateMessagesById(hydrated.serverMessages);
      slot.realtimeMessages = deduplicateMessagesById([
        ...hydrated.realtimeMessages,
        ...slot.realtimeMessages,
      ]);
      slot.total = typeof hydrated.metadata?.total === 'number'
        ? hydrated.metadata.total
        : slot.serverMessages.length;
      slot.hasMore = Boolean(hydrated.metadata?.hasMore);
      slot.offset = typeof hydrated.metadata?.offset === 'number'
        ? hydrated.metadata.offset
        : slot.serverMessages.length;
      slot.canonicalRevision = typeof hydrated.metadata?.canonicalRevision === 'string'
        ? hydrated.metadata.canonicalRevision
        : typeof hydrated.metadata?.revision === 'string' ? hydrated.metadata.revision : null;
      // A hydrated slot is intentionally stale from the network's perspective.
      // It can render immediately, while the normal loader still fetches the
      // authoritative transcript.
      slot.fetchedAt = 0;
      recomputeMergedIfNeeded(slot);
      bumpViewRevision(slot);
      notify(sessionId);
      const durationMs = Date.now() - startedAt;
      incrementDiagnosticMetric('hydrationDuration', durationMs);
      logDiagnostic({ level: 'info', area: 'session_store', event: 'cache_hydration_succeeded', sessionId, generation, cacheRevision: slot.canonicalRevision ?? undefined, durationMs, outcome: 'hydrated', metadata: { messageCount: slot.serverMessages.length } });
      return slot;
    } catch (error) {
      logCacheFailure('hydration', error);
      return slot;
    }
    })().finally(() => {
      if (slot._cacheHydrationInFlight === hydration) slot._cacheHydrationInFlight = null;
    });
    slot._cacheHydrationInFlight = hydration;
    return hydration;
  }, [cache, getSlot, logCacheFailure, notify]);

  const has = useCallback((sessionId: string) => {
    return storeRef.current.has(sessionId);
  }, []);

  /**
   * Fetch messages from the provider sessions endpoint and populate serverMessages.
   *
   * Provider and project metadata are resolved server-side from `sessionId`.
   * The endpoint returns the standard `{ success, data }` envelope.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
      /** Coordinator callers persist once with manifest metadata afterward. */
      persistCache?: boolean;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    const isCompleteRequest = opts.limit === null || opts.limit === undefined;
    if (isCompleteRequest && slot._canonicalFetchInFlight) {
      return slot._canonicalFetchInFlight;
    }
    const policy = getSessionWarmupPolicy({
      hasCompleteSnapshot: hasCompleteCanonicalSnapshot({
        canonicalRevision: slot.canonicalRevision,
        serverMessageCount: slot.serverMessages.length,
        total: slot.total,
        hasMore: slot.hasMore,
        offset: slot.offset,
      }),
      fetchedAt: slot.fetchedAt,
      now: Date.now(),
      staleThresholdMs: STALE_THRESHOLD_MS,
      messageCount: slot.merged.length,
    });
    if (isCompleteRequest && policy.reuseFreshSnapshot) return slot;

    const request = (async () => {
    const fetchTicket = ++slot._fetchSeq;
    const generation = storeGenerationRef.current;
    const namespace = userNamespaceRef.current;
    const cacheEpoch = cacheWriteEpochRef.current;
    // Hydration deliberately runs alongside the request. If it resolves first,
    // the active view can render durable rows while the network is in flight;
    // the fetch ticket/generation checks below keep a later response canonical.
    void hydrateFromCache(sessionId);
    slot.status = 'loading';
    bumpViewRevision(slot);
    notify(sessionId);

    try {
      const hasReusableCanonicalSnapshot = isCompleteRequest && hasCompleteCanonicalSnapshot({
        canonicalRevision: slot.canonicalRevision,
        serverMessageCount: slot.serverMessages.length,
        total: slot.total,
        hasMore: slot.hasMore,
        offset: slot.offset,
      });
      let result = await apiClient.sessionHistory(sessionId, {
        limit: opts.limit,
        offset: opts.offset,
        revision: hasReusableCanonicalSnapshot ? slot.canonicalRevision ?? undefined : undefined,
      });
      if (result.notModified && (
        !canReuseNotModified(slot.canonicalRevision, result.revision)
        || !hasCompleteCanonicalSnapshot({
          canonicalRevision: slot.canonicalRevision,
          serverMessageCount: slot.serverMessages.length,
          total: slot.total,
          hasMore: slot.hasMore,
          offset: slot.offset,
        })
      )) {
        logDiagnostic({ level: 'warn', area: 'session_store', event: 'canonical_304_rejected', sessionId, canonicalRevision: result.revision, cacheRevision: slot.canonicalRevision ?? undefined, outcome: 'full_refetch' });
        result = await apiClient.sessionHistory(sessionId, { limit: opts.limit, offset: opts.offset });
      }
      if (result.notModified) {
        if (fetchTicket > slot._appliedFetchSeq) slot._appliedFetchSeq = fetchTicket;
        slot.status = 'idle';
        slot.fetchedAt = Date.now();
        bumpViewRevision(slot);
        notify(sessionId);
        logDiagnostic({ level: 'info', area: 'session_store', event: 'canonical_not_modified', sessionId, canonicalRevision: result.revision, outcome: 'accepted' });
        return slot;
      }
      const data = result.data;
      const messages = data.messages as NormalizedMessage[];

      // A later-started fetch already applied: this response is stale.
      if (
        fetchTicket <= slot._appliedFetchSeq
        || generation !== storeGenerationRef.current
        || namespace !== userNamespaceRef.current
        || cacheEpoch !== cacheWriteEpochRef.current
      ) {
        incrementDiagnosticMetric('staleResponseRejection');
        logDiagnostic({ level: 'warn', area: 'session_store', event: 'canonical_response_rejected', sessionId, canonicalRevision: result.revision, outcome: 'stale' });
        return slot;
      }
      slot._appliedFetchSeq = fetchTicket;

       slot.serverMessages = deduplicateMessagesById(messages);
       slot.total = data.total ?? messages.length;
       slot.canonicalRevision = isCompleteRequest ? result.revision : slot.canonicalRevision;
       slot.hasMore = isCompleteRequest ? false : Boolean(data.hasMore);
       slot.offset = isCompleteRequest ? messages.length : (opts.offset ?? 0) + messages.length;
      slot.fetchedAt = Date.now();
      slot.status = 'idle';
      recomputeMergedIfNeeded(slot);
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }
      bumpViewRevision(slot);

      if ((opts.limit === null || opts.limit === undefined) && opts.persistCache !== false) {
        const metadata: SessionSyncMetadata = {
          fetchedAt: slot.fetchedAt,
          total: slot.total,
          hasMore: slot.hasMore,
          offset: slot.offset,
          canonicalRevision: slot.canonicalRevision,
        };
        persistAuthoritativeSlot(sessionId, slot, metadata);
      }

      notify(sessionId);
      logDiagnostic({ level: 'info', area: 'session_store', event: 'canonical_revision_accepted', sessionId, canonicalRevision: slot.canonicalRevision ?? undefined, outcome: 'accepted', metadata: { messageCount: messages.length } });
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
      // Don't clobber a newer fetch's result with a stale failure.
      if (fetchTicket > slot._appliedFetchSeq) {
        slot.status = 'error';
        bumpViewRevision(slot);
        notify(sessionId);
      }
      return slot;
    }
    })().finally(() => {
      if (slot._canonicalFetchInFlight === request) {
        slot._canonicalFetchInFlight = null;
        bumpViewRevision(slot);
        notify(sessionId);
      }
    });
    if (isCompleteRequest) slot._canonicalFetchInFlight = request;
    return request;
  }, [getSlot, hydrateFromCache, notify, persistAuthoritativeSlot]);

  const warmSession = useCallback((sessionId: string): Promise<SessionSlot> => {
    const slot = getSlot(sessionId);
    const policy = getSessionWarmupPolicy({
      hasCompleteSnapshot: hasCompleteCanonicalSnapshot({
        canonicalRevision: slot.canonicalRevision,
        serverMessageCount: slot.serverMessages.length,
        total: slot.total,
        hasMore: slot.hasMore,
        offset: slot.offset,
      }),
      fetchedAt: slot.fetchedAt,
      now: Date.now(),
      staleThresholdMs: STALE_THRESHOLD_MS,
      messageCount: slot.merged.length,
    });
    if (policy.reuseFreshSnapshot) return Promise.resolve(slot);
    void hydrateFromCache(sessionId);
    return fetchFromServer(sessionId);
  }, [fetchFromServer, getSlot, hydrateFromCache]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    if (!slot.hasMore) return slot;

    const fetchTicket = ++slot._fetchSeq;
    const generation = storeGenerationRef.current;
    const namespace = userNamespaceRef.current;
    const cacheEpoch = cacheWriteEpochRef.current;
    const limit = opts.limit ?? 20;

    try {
      const result = await apiClient.sessionHistory(sessionId, { limit, offset: slot.offset });
      if (result.notModified) return slot;
      const data = result.data;
      const olderMessages = data.messages as NormalizedMessage[];

      // A full fetch/refresh replaced serverMessages while this page was in
      // flight — prepending onto the new array would duplicate or misorder.
      if (
        fetchTicket <= slot._appliedFetchSeq
        || generation !== storeGenerationRef.current
        || namespace !== userNamespaceRef.current
        || cacheEpoch !== cacheWriteEpochRef.current
      ) {
        return slot;
      }
      slot._appliedFetchSeq = fetchTicket;

      // Prepend older messages (they're earlier in the conversation)
      slot.serverMessages = [...olderMessages, ...slot.serverMessages];
      slot.serverMessages = deduplicateMessagesById(slot.serverMessages);
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = slot.offset + olderMessages.length;
      recomputeMergedIfNeeded(slot);
      bumpViewRevision(slot);
      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };
    if (slot.serverMessages.some((message) => message.id === normalizedMessage.id)) {
      return;
    }
    let updated = upsertMessageById(slot.realtimeMessages, normalizedMessage);
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    bumpViewRevision(slot);
    persistRealtimeMessage(sessionId, normalizedMessage);
    notify(sessionId);
  }, [getSlot, notify, persistRealtimeMessage]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    const normalizedMessages = msgs.map((msg) =>
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId },
    ).filter((message) => !slot.serverMessages.some((serverMessage) => serverMessage.id === message.id));
    if (normalizedMessages.length === 0) return;
    let updated = normalizedMessages.reduce(
      (current, message) => upsertMessageById(current, message),
      slot.realtimeMessages,
    );
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    bumpViewRevision(slot);
    for (const message of normalizedMessages) {
      persistRealtimeMessage(sessionId, message);
    }
    notify(sessionId);
  }, [getSlot, notify, persistRealtimeMessage]);

  type IngestResult = {
    status: 'accepted' | 'duplicate' | 'stale_generation' | 'gap' | 'unsequenced';
    sessionId: string;
    generation?: number;
    seq?: number;
  };

  const ingestRealtimeEvent = useCallback((event: NormalizedMessage): IngestResult => {
    const sessionId = event.sessionId;
    const slot = getSlot(sessionId);
    if (typeof event.generation !== 'number' || typeof event.seq !== 'number') {
      logDiagnostic({ level: 'debug', area: 'session_store', event: 'realtime_event_unsequenced', sessionId, outcome: 'unsequenced', metadata: { kind: event.kind } });
      return { status: 'unsequenced', sessionId };
    }

    const acceptance = acceptSequencedEvent(slot.realtimeCursor, event.generation, event.seq);
    if (acceptance.status !== 'accepted') {
      if (acceptance.status === 'gap') incrementDiagnosticMetric('replayGap');
      if (acceptance.status === 'duplicate') incrementDiagnosticMetric('duplicateEventRejection');
      if (acceptance.status === 'stale_generation') incrementDiagnosticMetric('staleResponseRejection');
      logDiagnostic({ level: 'warn', area: 'session_store', event: 'realtime_event_rejected', sessionId, generation: event.generation, seq: event.seq, outcome: acceptance.status });
      return { status: acceptance.status, sessionId, generation: event.generation, seq: event.seq };
    }

    if (acceptance.generationChanged) {
      commitRealtimeStream(sessionId, { notify: false });
      slot.realtimeStream = null;
    }
    slot.realtimeCursor = acceptance.cursor;

    if (event.kind !== 'stream_delta') {
      commitRealtimeStream(sessionId, { notify: false, persist: false });
    }

    const previousStream = slot.realtimeStream;
    slot.realtimeStream = reduceRealtimeStream(previousStream, {
      kind: event.kind,
      generation: event.generation,
      content: event.content,
      timestamp: event.timestamp,
      provider: event.provider,
    });

    if (event.kind === 'stream_delta') {
      scheduleRealtimeStreamCommit(sessionId);
      return { status: 'accepted', sessionId, generation: event.generation, seq: event.seq };
    } else if (event.kind === 'stream_end' || event.kind === 'complete') {
      if (previousStream?.generation === event.generation) {
        const streamId = `__streaming_${sessionId}_${event.generation}`;
        const index = slot.realtimeMessages.findIndex((message) => message.id === streamId);
        if (index >= 0) {
          const finalized = finalizeRealtimeStreamMessage(slot.realtimeMessages[index], event);
          slot.realtimeMessages = [...slot.realtimeMessages];
          slot.realtimeMessages[index] = finalized;
          persistRealtimeMessage(sessionId, finalized);
        }
      }
    } else if (!['status', 'permission_request', 'permission_cancelled'].includes(event.kind)) {
      if (!slot.serverMessages.some((message) => message.id === event.id)) {
        slot.realtimeMessages = upsertMessageById(slot.realtimeMessages, event);
        persistRealtimeMessage(sessionId, event);
      }
    }
    if (slot.realtimeMessages.length > MAX_REALTIME_MESSAGES) {
      slot.realtimeMessages = slot.realtimeMessages.slice(-MAX_REALTIME_MESSAGES);
    }
    recomputeMergedIfNeeded(slot);
    bumpViewRevision(slot);
    notify(sessionId);
    return { status: 'accepted', sessionId, generation: event.generation, seq: event.seq };
  }, [commitRealtimeStream, getSlot, notify, persistRealtimeMessage, scheduleRealtimeStreamCommit]);

  const getRealtimeCursor = useCallback((sessionId: string): RealtimeCursor | null => {
    return storeRef.current.get(sessionId)?.realtimeCursor ?? null;
  }, []);

  const getSubscriptionTarget = useCallback((sessionId: string) => {
    const cursor = storeRef.current.get(sessionId)?.realtimeCursor;
    return cursor
      ? { sessionId, generation: cursor.generation, lastSeq: cursor.seq }
      : { sessionId };
  }, []);

  /**
   * Re-fetch serverMessages from the provider sessions endpoint.
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
    options: RefreshFromServerOptions = {},
  ) => {
    const slot = getSlot(sessionId);
    const fetchTicket = ++slot._fetchSeq;
    const generation = storeGenerationRef.current;
    const namespace = userNamespaceRef.current;
    try {
      const result = await historyOwnerRef.current!.read(sessionId, { force: options.force });
      if (result.notModified) return;
      const data = result.data;

      // A later-started fetch already applied: applying this stale transcript
      // would erase rows the user has already seen (and re-prune realtime
      // rows against an outdated snapshot).
      if (
        fetchTicket <= slot._appliedFetchSeq
        || generation !== storeGenerationRef.current
        || namespace !== userNamespaceRef.current
      ) {
        incrementDiagnosticMetric('staleResponseRejection');
        logDiagnostic({ level: 'warn', area: 'session_store', event: 'canonical_response_rejected', sessionId, canonicalRevision: result.revision, outcome: 'stale_recovery' });
        return;
      }
      slot._appliedFetchSeq = fetchTicket;

       slot.serverMessages = deduplicateMessagesById(data.messages as NormalizedMessage[]);
       slot.total = data.total ?? slot.serverMessages.length;
       slot.hasMore = false;
       slot.offset = slot.serverMessages.length;
       slot.fetchedAt = Date.now();
       slot.canonicalRevision = result.revision;
      // Only drop realtime rows the server transcript now owns. A blind clear
      // here caused the chat pane to flash "Continue your conversation" after
      // `complete` while JSONL / provider_session_id indexing was still behind.
       slot.realtimeMessages = pruneRealtimeSupersededByServer(
         slot.serverMessages,
         slot.realtimeMessages,
       );
       recomputeMergedIfNeeded(slot);
       bumpViewRevision(slot);
       const metadata: SessionSyncMetadata = {
         fetchedAt: slot.fetchedAt,
         total: slot.total,
         hasMore: slot.hasMore,
         offset: slot.offset,
         canonicalRevision: slot.canonicalRevision,
       };
       persistAuthoritativeSlot(sessionId, slot, metadata);
       notify(sessionId);
       logDiagnostic({ level: 'info', area: 'session_store', event: 'canonical_revision_accepted', sessionId, canonicalRevision: slot.canonicalRevision ?? undefined, outcome: 'recovery_accepted', metadata: { messageCount: slot.serverMessages.length } });
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  }, [getSlot, notify, persistAuthoritativeSlot]);

  const recoverSession = useCallback((sessionId: string): Promise<void> => {
    const slot = getSlot(sessionId);
    if (slot.recoveryInFlight) {
      logDiagnostic({ level: 'debug', area: 'session_store', event: 'rest_recovery_deduplicated', sessionId, outcome: 'in_flight' });
      return slot.recoveryInFlight;
    }
    incrementDiagnosticMetric('restRecovery');
    logDiagnostic({ level: 'info', area: 'session_store', event: 'rest_recovery_started', sessionId });
    historyOwnerRef.current?.invalidate(sessionId);
    const recovery = refreshFromServer(sessionId).then(() => undefined).finally(() => {
      logDiagnostic({ level: 'info', area: 'session_store', event: 'rest_recovery_completed', sessionId, canonicalRevision: slot.canonicalRevision ?? undefined, outcome: 'completed' });
      if (slot.recoveryInFlight === recovery) slot.recoveryInFlight = null;
    });
    slot.recoveryInFlight = recovery;
    return recovery;
  }, [getSlot, refreshFromServer]);

  /** Fetch and persist a complete canonical transcript for coordinator callers. */
  const synchronizeSession = useCallback(async (
    sessionId: string,
    metadata: CompleteSessionSyncOptions = {},
  ) => {
    const slot = await fetchFromServer(sessionId, {
      limit: null,
      offset: 0,
      persistCache: false,
    });
    if (slot && slot.status !== 'error' && slot._appliedFetchSeq > 0 && userNamespaceRef.current) {
      persistAuthoritativeSlot(sessionId, slot, {
        ...metadata,
        fetchedAt: metadata.fetchedAt ?? slot.fetchedAt,
        total: slot.total,
        hasMore: slot.hasMore,
        offset: slot.offset,
      });
    }
    return slot;
  }, [fetchFromServer, persistAuthoritativeSlot]);

  const getCachedRevision = useCallback(async (sessionId: string): Promise<CacheRevision> => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return null;
    try {
      return await cache.getSessionRevision(namespace, sessionId);
    } catch (error) {
      logCacheFailure('revision lookup', error);
      return null;
    }
  }, [cache, logCacheFailure]);

  const getCachedMetadata = useCallback(async (sessionId: string): Promise<SessionSyncMetadata | null> => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return null;
    try {
      return await cache.getSessionMetadata(namespace, sessionId);
    } catch (error) {
      logCacheFailure('metadata lookup', error);
      return null;
    }
  }, [cache, logCacheFailure]);

  const recordCachedMetadata = useCallback(async (
    sessionId: string,
    metadata: SessionSyncMetadata,
  ): Promise<boolean> => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return false;
    try {
      return await cache.setSessionMetadata(namespace, sessionId, metadata);
    } catch (error) {
      logCacheFailure('metadata write', error);
      return false;
    }
  }, [cache, logCacheFailure]);

  const cleanupCache = useCallback(async (manifest: readonly (SessionManifestEntry | string)[]) => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return [];
    try {
      return await cache.removeSessionsNotInManifest(namespace, manifest);
    } catch (error) {
      logCacheFailure('cleanup', error);
      return [];
    }
  }, [cache, logCacheFailure]);

  const getActiveSessionId = useCallback(() => activeSessionIdRef.current, []);

  const fetchCacheManifest = useCallback(async (): Promise<readonly SessionCacheManifestEntry[] | null> => {
    const response = await authenticatedFetch('/api/providers/sessions/manifest');
    if (!response.ok) {
      throw new Error(`Manifest request failed with HTTP ${response.status}`);
    }
    const body = await response.json() as { data?: { sessions?: unknown } };
    return parseSessionCacheManifest(body?.data?.sessions) ?? null;
  }, []);

  const getCacheStats = useCallback(async (): Promise<CacheStats> => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return { sessionCount: 0, messageCount: 0 };
    try {
      return await cache.getCacheStats(namespace);
    } catch (error) {
      logCacheFailure('stats lookup', error);
      return { sessionCount: 0, messageCount: 0 };
    }
  }, [cache, logCacheFailure]);

  const clearUserCache = useCallback(async (): Promise<boolean> => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return false;
    try {
      return await cache.clearUserCache(namespace);
    } catch (error) {
      logCacheFailure('clear', error);
      return false;
    }
  }, [cache, logCacheFailure]);

  const beginCacheClear = useCallback(() => {
    cacheWriteEpochRef.current += 1;
    cacheWritesBlockedRef.current = true;
  }, []);

  const endCacheClear = useCallback(() => {
    cacheWritesBlockedRef.current = false;
  }, []);

  const cacheCoordinator = useMemo(() => new SessionCacheSyncCoordinator({
    fetchManifest: fetchCacheManifest,
    getCachedMetadata,
    synchronizeSession,
    recordSessionMetadata: recordCachedMetadata,
    cleanupCache,
    getActiveSessionId,
    waitForCacheWrites,
    getCacheStats,
    clearCache: clearUserCache,
    beginCacheClear,
    endCacheClear,
    automaticConcurrency: AUTOMATIC_CACHE_SYNC_CONCURRENCY,
    manualConcurrency: MANUAL_CACHE_SYNC_CONCURRENCY,
    onError: (error, sessionId) => {
      const scope = sessionId ? ` for ${sessionId}` : '';
      console.warn(`[SessionCacheCoordinator] sync failed${scope}:`, error);
    },
  }), [
    fetchCacheManifest, getCachedMetadata, synchronizeSession, recordCachedMetadata,
    cleanupCache, getActiveSessionId, waitForCacheWrites, getCacheStats,
    clearUserCache, beginCacheClear, endCacheClear,
  ]);
  const forceSyncCache = useCallback(() => cacheCoordinator.forceSync(), [cacheCoordinator]);
  const clearCache = useCallback(() => cacheCoordinator.clearCache(), [cacheCoordinator]);

  const requestCachePersistence = useCallback(() => {
    return cache.requestPersistentStorage().catch((error) => {
      logCacheFailure('persistent storage request', error);
      return false;
    });
  }, [cache, logCacheFailure]);

  const refreshCacheStorageStatus = useCallback(async (requestPersistence = false) => {
    if (requestPersistence) await requestCachePersistence();
    const status = await inspectBrowserStorage();
    const failure = cache.failureKind === 'none' ? status.failure : cache.failureKind;
    const next = { ...status, failure };
    setCacheStorageStatus((previous) => cacheStorageStatusesMatch(previous, next) ? previous : next);
    return next;
  }, [cache, requestCachePersistence]);

  const prioritizeSession = useCallback((sessionId: string | null) => {
    if (sessionId) activeSessionIdRef.current = sessionId;
  }, []);

  const persistMessage = useCallback((sessionId: string, message: NormalizedMessage) => {
    persistRealtimeMessage(sessionId, message);
  }, [persistRealtimeMessage]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    commitRealtimeStream(sessionId);
    const slot = getSlot(sessionId);
    slot.status = status;
    bumpViewRevision(slot);
    notify(sessionId);
  }, [commitRealtimeStream, getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const slot = getSlot(sessionId);
    const streamId = `__streaming_${sessionId}`;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    bumpViewRevision(slot);
    persistRealtimeMessage(sessionId, msg);
    notify(sessionId);
  }, [getSlot, notify, persistRealtimeMessage]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__streaming_${sessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'text',
        role: 'assistant',
      };
      deleteCachedRealtimeMessage(sessionId, streamId);
      persistRealtimeMessage(sessionId, slot.realtimeMessages[idx]);
      recomputeMergedIfNeeded(slot);
      bumpViewRevision(slot);
      notify(sessionId);
    }
  }, [deleteCachedRealtimeMessage, notify, persistRealtimeMessage]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((sessionId: string) => {
    commitRealtimeStream(sessionId);
    const slot = storeRef.current.get(sessionId);
    if (slot) {
      const previousRealtimeMessages = slot.realtimeMessages;
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      bumpViewRevision(slot);
      const namespace = userNamespaceRef.current;
      if (namespace) {
        for (const message of previousRealtimeMessages) {
          deleteCachedRealtimeMessage(sessionId, message.id);
        }
      }
      notify(sessionId);
    }
  }, [commitRealtimeStream, deleteCachedRealtimeMessage, notify]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.merged ?? [];
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, []);

  const getCanonicalResponseMetadata = useCallback((
    sessionId: string,
  ): CanonicalResponseMetadataSnapshot => {
    return getCanonicalResponseMetadataSnapshot(storeRef.current.get(sessionId)?.serverMessages ?? EMPTY);
  }, []);

  const isCanonicalResponseMetadataHydrated = useCallback((
    sessionId: string,
    baseline: CanonicalResponseMetadataSnapshot,
  ): boolean => {
    return isCanonicalResponseMetadataReady(baseline, getCanonicalResponseMetadata(sessionId));
  }, [getCanonicalResponseMetadata]);

  const getSessionSnapshot = useCallback((sessionId: string): SessionSnapshot => {
    const slot = storeRef.current.get(sessionId);
    const previous = snapshotRef.current.get(sessionId);
    if (previous && slot && previous.revision === slot.viewRevision) return previous;
    if (previous && !slot) return previous;
    const source = slot ?? createEmptySlot();
    const snapshot = {
      messages: source.merged,
      status: source.status,
      total: source.total,
      hasMore: source.hasMore,
      fetchedAt: source.fetchedAt,
      offset: source.offset,
      tokenUsage: source.tokenUsage,
      revision: source.viewRevision,
      canonicalRevision: source.canonicalRevision,
      hasDisplayableMessages: source.merged.length > 0,
      isCanonicalLoading: source._canonicalFetchInFlight !== null,
    };
    snapshotRef.current.set(sessionId, snapshot);
    return snapshot;
  }, []);

  return useMemo(() => ({
    getSlot,
    has,
    hydrateFromCache,
    warmSession,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    ingestRealtimeEvent,
    getRealtimeCursor,
    getSubscriptionTarget,
    recoverSession,
    refreshFromServer,
    synchronizeSession,
    cacheCoordinator,
    getCacheStats,
    forceSyncCache,
    clearCache,
    getCachedRevision,
    getCachedMetadata,
    recordCachedMetadata,
    cleanupCache,
    requestCachePersistence,
    refreshCacheStorageStatus,
    cacheStorageStatus,
    persistMessage,
    prioritizeSession,
    getActiveSessionId,
    setActiveSession,
    setChatSurfaceActive,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    getMessages,
    getSessionSlot,
    getSessionSnapshot,
    getCanonicalResponseMetadata,
    isCanonicalResponseMetadataHydrated,
  }), [
    getSlot, has, hydrateFromCache, warmSession, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, ingestRealtimeEvent, getRealtimeCursor,
    getSubscriptionTarget, recoverSession, refreshFromServer,
    synchronizeSession, getCachedRevision, getCachedMetadata, recordCachedMetadata,
    cleanupCache, requestCachePersistence, refreshCacheStorageStatus, cacheStorageStatus,
    cacheCoordinator, getCacheStats,
    forceSyncCache, clearCache,
    persistMessage, prioritizeSession, getActiveSessionId,
    setActiveSession, setChatSurfaceActive, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, getMessages, getSessionSlot, getSessionSnapshot,
    getCanonicalResponseMetadata, isCanonicalResponseMetadataHydrated,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
