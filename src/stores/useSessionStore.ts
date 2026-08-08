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
import type { LLMProvider } from '../types/app';

import {
  SessionMessageCacheRepository,
  type CacheStats,
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
  deduplicateMessagesById,
  reduceRealtimeStream,
  shouldApplyCacheHydration,
  upsertMessageById,
  type RealtimeCursor,
  type RealtimeStreamState,
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
    realtimeCursor: null,
    realtimeStream: null,
    recoveryInFlight: null,
    viewRevision: 0,
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
}

export interface CompleteSessionSyncOptions {
  revision?: CacheRevision;
  fetchedAt?: number | string | null;
  [key: string]: unknown;
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

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore(options: SessionStoreOptions = {}) {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  const initialNamespace = options.userNamespace ?? null;
  const userNamespaceRef = useRef<string | null>(initialNamespace);
  const storeGenerationRef = useRef(0);
  const cacheRef = useRef<SessionMessageCacheRepository | null>(null);
  const cacheWriteChainsRef = useRef(new Map<string, Promise<void>>());
  const cacheWritesBlockedRef = useRef(false);
  const cacheWriteEpochRef = useRef(0);
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
    activeSessionIdRef.current = null;
  }

  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly with
  // no alias/redirect indirection.
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const logCacheFailure = useCallback((operation: string, error: unknown) => {
    // Persistence is an optimization. Keep failures visible to developers but
    // never let them reject a network chat operation or surface in the UI.
    console.warn(`[SessionStore] cache ${operation} failed:`, error);
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
      },
    }), epoch);
  }, [cache, enqueueCacheWrite]);

  const persistRealtimeMessage = useCallback((sessionId: string, message: NormalizedMessage) => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return;
    enqueueCacheWrite(sessionId, () => cache.upsertRealtimeMessage(namespace, sessionId, message));
  }, [cache, enqueueCacheWrite]);

  const deleteCachedRealtimeMessage = useCallback((sessionId: string, messageId: string) => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return;
    enqueueCacheWrite(sessionId, () => cache.deleteRealtimeMessage(namespace, sessionId, messageId));
  }, [cache, enqueueCacheWrite]);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
    }
    return store.get(sessionId)!;
  }, []);

  const hydrateFromCache = useCallback(async (sessionId: string) => {
    const namespace = userNamespaceRef.current;
    if (!namespace) return getSlot(sessionId);
    const slot = getSlot(sessionId);
    if (slot._cacheHydrationStarted) return slot;
    slot._cacheHydrationStarted = true;
    const hydrationTicket = ++slot._cacheHydrationSeq;
    const generation = storeGenerationRef.current;

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
      // A hydrated slot is intentionally stale from the network's perspective.
      // It can render immediately, while the normal loader still fetches the
      // authoritative transcript.
      slot.fetchedAt = 0;
      recomputeMergedIfNeeded(slot);
      bumpViewRevision(slot);
      notify(sessionId);
      return slot;
    } catch (error) {
      logCacheFailure('hydration', error);
      return slot;
    }
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
      const params = new URLSearchParams();
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append('limit', String(opts.limit));
        params.append('offset', String(opts.offset ?? 0));
      }

      const qs = params.toString();
      const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.json();
      const data = body?.data ?? body;
      const messages: NormalizedMessage[] = data.messages || [];

      // A later-started fetch already applied: this response is stale.
      if (
        fetchTicket <= slot._appliedFetchSeq
        || generation !== storeGenerationRef.current
        || namespace !== userNamespaceRef.current
        || cacheEpoch !== cacheWriteEpochRef.current
      ) {
        return slot;
      }
      slot._appliedFetchSeq = fetchTicket;

       slot.serverMessages = deduplicateMessagesById(messages);
       slot.total = data.total ?? messages.length;
       const isCompleteRequest = opts.limit === null || opts.limit === undefined;
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
        };
        if (data.revision !== undefined) metadata.revision = data.revision;
        else if (data.updatedAt !== undefined) metadata.revision = data.updatedAt;
        persistAuthoritativeSlot(sessionId, slot, metadata);
      }

      notify(sessionId);
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
  }, [getSlot, hydrateFromCache, notify, persistAuthoritativeSlot]);

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
    const params = new URLSearchParams();
    const limit = opts.limit ?? 20;
    params.append('limit', String(limit));
    params.append('offset', String(slot.offset));

    const qs = params.toString();
    const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;
      const olderMessages: NormalizedMessage[] = data.messages || [];

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
      return { status: 'unsequenced', sessionId };
    }

    const acceptance = acceptSequencedEvent(slot.realtimeCursor, event.generation, event.seq);
    if (acceptance.status !== 'accepted') {
      return { status: acceptance.status, sessionId, generation: event.generation, seq: event.seq };
    }

    if (acceptance.generationChanged) {
      const previousStreamId = slot.realtimeStream
        ? `__streaming_${sessionId}_${slot.realtimeStream.generation}`
        : null;
      slot.realtimeStream = null;
      if (previousStreamId) {
        slot.realtimeMessages = slot.realtimeMessages.filter((message) => message.id !== previousStreamId);
        deleteCachedRealtimeMessage(sessionId, previousStreamId);
      }
    }
    slot.realtimeCursor = acceptance.cursor;

    const previousStream = slot.realtimeStream;
    slot.realtimeStream = reduceRealtimeStream(previousStream, {
      kind: event.kind,
      generation: event.generation,
      content: event.content,
      timestamp: event.timestamp,
    });

    if (event.kind === 'stream_delta') {
      const stream = slot.realtimeStream!;
      const streamMessage: NormalizedMessage = {
        ...event,
        id: `__streaming_${sessionId}_${event.generation}`,
        kind: 'stream_delta',
        content: stream.content,
        timestamp: stream.startedAt,
      };
      slot.realtimeMessages = upsertMessageById(slot.realtimeMessages, streamMessage);
      persistRealtimeMessage(sessionId, streamMessage);
    } else if (event.kind === 'stream_end' || event.kind === 'complete') {
      if (previousStream?.generation === event.generation) {
        const streamId = `__streaming_${sessionId}_${event.generation}`;
        const index = slot.realtimeMessages.findIndex((message) => message.id === streamId);
        if (index >= 0) {
          const finalized: NormalizedMessage = {
            ...slot.realtimeMessages[index],
            kind: 'text',
            role: 'assistant',
          };
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
  }, [deleteCachedRealtimeMessage, getSlot, notify, persistRealtimeMessage]);

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
  ) => {
    const slot = getSlot(sessionId);
    const fetchTicket = ++slot._fetchSeq;
    const generation = storeGenerationRef.current;
    const namespace = userNamespaceRef.current;
    try {
      const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`;
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;

      // A later-started fetch already applied: applying this stale transcript
      // would erase rows the user has already seen (and re-prune realtime
      // rows against an outdated snapshot).
      if (
        fetchTicket <= slot._appliedFetchSeq
        || generation !== storeGenerationRef.current
        || namespace !== userNamespaceRef.current
      ) {
        return;
      }
      slot._appliedFetchSeq = fetchTicket;

       slot.serverMessages = deduplicateMessagesById(data.messages || []);
       slot.total = data.total ?? slot.serverMessages.length;
       slot.hasMore = false;
       slot.offset = slot.serverMessages.length;
       slot.fetchedAt = Date.now();
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
       };
       if (data.revision !== undefined) metadata.revision = data.revision;
       else if (data.updatedAt !== undefined) metadata.revision = data.updatedAt;
       persistAuthoritativeSlot(sessionId, slot, metadata);
       notify(sessionId);
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  }, [getSlot, notify, persistAuthoritativeSlot]);

  const recoverSession = useCallback((sessionId: string): Promise<void> => {
    const slot = getSlot(sessionId);
    if (slot.recoveryInFlight) return slot.recoveryInFlight;
    const recovery = refreshFromServer(sessionId).then(() => undefined).finally(() => {
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
    const slot = getSlot(sessionId);
    slot.status = status;
    bumpViewRevision(slot);
    notify(sessionId);
  }, [getSlot, notify]);

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
  }, [deleteCachedRealtimeMessage, notify]);

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

  const getSessionSnapshot = useCallback((sessionId: string): SessionSnapshot => {
    const slot = storeRef.current.get(sessionId) ?? createEmptySlot();
    return {
      messages: slot.merged,
      status: slot.status,
      total: slot.total,
      hasMore: slot.hasMore,
      fetchedAt: slot.fetchedAt,
      offset: slot.offset,
      tokenUsage: slot.tokenUsage,
      revision: slot.viewRevision,
    };
  }, []);

  return useMemo(() => ({
    getSlot,
    has,
    hydrateFromCache,
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
    persistMessage,
    prioritizeSession,
    getActiveSessionId,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    getMessages,
    getSessionSlot,
    getSessionSnapshot,
  }), [
    getSlot, has, hydrateFromCache, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, ingestRealtimeEvent, getRealtimeCursor,
    getSubscriptionTarget, recoverSession, refreshFromServer,
    synchronizeSession, getCachedRevision, getCachedMetadata, recordCachedMetadata,
    cleanupCache, requestCachePersistence,
    cacheCoordinator, getCacheStats,
    forceSyncCache, clearCache,
    persistMessage, prioritizeSession, getActiveSessionId,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, getMessages, getSessionSlot, getSessionSnapshot,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
