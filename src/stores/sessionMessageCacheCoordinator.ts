import type { ServerEvent } from '../contexts/webSocketTypes';
import type { LLMProvider } from '../types/app';

import type {
  CacheStats,
  CacheRevision,
  SessionManifestEntry,
  SessionSyncMetadata,
} from './sessionMessageCache';
import type { NormalizedMessage } from './normalizedMessage';

export interface SessionCacheManifestEntry extends SessionManifestEntry {
  provider: LLMProvider;
  archived: boolean;
  historyReady: boolean;
}

interface SessionCacheManifestWireEntry {
  sessionId?: unknown;
  provider?: unknown;
  revision?: unknown;
  archived?: unknown;
  isArchived?: unknown;
  historyReady?: unknown;
}

export interface SessionCacheSyncPlan {
  entry: SessionCacheManifestEntry;
  reason: 'missing' | 'changed' | 'invalidated' | 'active' | 'forced';
}

export interface SessionCacheForceSyncResult {
  eligible: number;
  succeeded: number;
  failed: number;
  success: boolean;
  manifestValid: boolean;
}

export interface SessionCacheClearResult {
  success: boolean;
  stats: CacheStats;
}

export interface SessionCacheSyncPolicyInput {
  manifest: readonly SessionCacheManifestEntry[];
  cachedMetadata: ReadonlyMap<string, SessionSyncMetadata | null>;
  invalidatedSessionIds?: ReadonlySet<string>;
  activeSessionId?: string | null;
  forceAll?: boolean;
}

/** Keep background cache refreshes conservative for browser/server load. */
export const AUTOMATIC_CACHE_SYNC_CONCURRENCY = 3;

/** Explicit user-triggered refreshes may use more parallel history requests. */
export const MANUAL_CACHE_SYNC_CONCURRENCY = 8;

const PROVIDERS = new Set<LLMProvider>(['claude', 'cursor', 'codex', 'opencode']);

/**
 * Gateway/control frames are useful to the UI but are not transcript rows.
 * Streaming frames are also omitted here: the chat store owns one throttled
 * synthetic stream row, and persisting every delta would create a row storm.
 */
const NON_PERSISTABLE_EVENT_KINDS = new Set<string>([
  'chat_subscribed',
  'complete',
  'loading_progress',
  'permission_cancelled',
  'permission_request',
  'protocol_error',
  'session_created',
  'status',
  'stream_delta',
  'stream_end',
  'websocket_reconnected',
  'session_upserted',
]);

const NORMALIZED_MESSAGE_KINDS = new Set<NormalizedMessage['kind']>([
  'text',
  'tool_use',
  'tool_result',
  'thinking',
  'error',
  'interactive_prompt',
  'task_notification',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCacheRevision(value: unknown): value is CacheRevision {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isFinite(value));
}

export function isSessionCacheManifestEntry(value: unknown): value is SessionCacheManifestEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionCacheManifestEntry>;
  return isNonEmptyString(candidate.sessionId)
    && PROVIDERS.has(candidate.provider as LLMProvider)
    && isCacheRevision(candidate.revision)
    && typeof candidate.archived === 'boolean'
    && typeof candidate.historyReady === 'boolean';
}

function normalizeSessionCacheManifestEntry(value: unknown): SessionCacheManifestEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as SessionCacheManifestWireEntry;
  const normalized = {
    sessionId: candidate.sessionId,
    provider: candidate.provider,
    revision: candidate.revision,
    archived: typeof candidate.isArchived === 'boolean' ? candidate.isArchived : candidate.archived,
    historyReady: candidate.historyReady,
  };
  return isSessionCacheManifestEntry(normalized) ? normalized : null;
}

/**
 * A manifest is authoritative only when every row passes validation. A
 * partially parsed response must never be allowed to trigger cache cleanup.
 */
export function parseSessionCacheManifest(value: unknown): SessionCacheManifestEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const ids = new Set<string>();
  const normalized = value.map(normalizeSessionCacheManifestEntry);
  if (normalized.some((entry): entry is null => entry === null)) return null;
  for (const entry of normalized as SessionCacheManifestEntry[]) {
    if (ids.has(entry.sessionId)) return null;
    ids.add(entry.sessionId);
  }

  return (normalized as SessionCacheManifestEntry[]).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

/**
 * Selects complete-history work without refetching an unchanged revision.
 * Invalidations intentionally override the revision comparison because a
 * websocket event can arrive before the manifest's persisted timestamp moves.
 */
export function planSessionCacheSync({
  manifest,
  cachedMetadata,
  invalidatedSessionIds = new Set<string>(),
  activeSessionId = null,
  forceAll = false,
}: SessionCacheSyncPolicyInput): SessionCacheSyncPlan[] {
  const plans: SessionCacheSyncPlan[] = [];

  for (const entry of manifest) {
    if (!entry.historyReady) continue;
    const metadata = cachedMetadata.get(entry.sessionId) ?? null;
    const invalidated = invalidatedSessionIds.has(entry.sessionId);
    const missing = !metadata;
    const changed = metadata?.revision !== entry.revision;
    const notReady = metadata?.historyReady === false;

    if (!forceAll && !invalidated && !missing && !changed && !notReady) continue;

    plans.push({
      entry,
      reason: forceAll ? 'forced' : invalidated ? 'invalidated' : missing ? 'missing' : changed ? 'changed' : 'active',
    });
  }

  return plans.sort((left, right) => {
    const priority = (plan: SessionCacheSyncPlan): number => {
      if (plan.reason === 'invalidated') return 0;
      if (plan.entry.sessionId === activeSessionId) return 1;
      return 2;
    };
    return priority(left) - priority(right) || left.entry.sessionId.localeCompare(right.entry.sessionId);
  });
}

export interface PersistableEventOptions {
  fallbackSessionId?: string | null;
}

/** Return a normalized visible message event, or null for control frames. */
export function getPersistableMessageEvent(
  event: ServerEvent,
  options: PersistableEventOptions = {},
): NormalizedMessage | null {
  if (!event || typeof event.kind !== 'string' || NON_PERSISTABLE_EVENT_KINDS.has(event.kind)) {
    return null;
  }

  const sessionId = isNonEmptyString(event.sessionId) ? event.sessionId : options.fallbackSessionId;
  if (!sessionId || !isNonEmptyString(event.id) || !isNonEmptyString(event.timestamp)) {
    return null;
  }
  if (!PROVIDERS.has(event.provider as LLMProvider)) return null;
  if (!NORMALIZED_MESSAGE_KINDS.has(event.kind as NormalizedMessage['kind'])) return null;

  return {
    ...event,
    id: event.id,
    sessionId,
    timestamp: event.timestamp,
    provider: event.provider as LLMProvider,
    kind: event.kind as NormalizedMessage['kind'],
  } as NormalizedMessage;
}

/**
 * Runs work with a fixed number of workers. Results preserve input order even
 * though individual tasks finish at different times.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));

  return results;
}

export class SessionCacheSyncCoordinator {
  private readonly inFlightSessions = new Map<string, Promise<boolean>>();
  private readonly invalidatedVersions = new Map<string, number>();
  private manifestInFlight: Promise<boolean> | null = null;
  private reconcileRequested = false;
  private operationTail: Promise<void> = Promise.resolve();
  private operationActive = false;

  constructor(
    private readonly dependencies: {
      fetchManifest: () => Promise<readonly SessionCacheManifestEntry[] | null>;
      getCachedMetadata: (sessionId: string) => Promise<SessionSyncMetadata | null>;
      synchronizeSession: (sessionId: string, metadata: SessionSyncMetadata) => Promise<unknown>;
      recordSessionMetadata: (sessionId: string, metadata: SessionSyncMetadata) => Promise<unknown>;
      cleanupCache: (manifest: readonly SessionCacheManifestEntry[]) => Promise<unknown>;
      getActiveSessionId: () => string | null;
      automaticConcurrency?: number;
      manualConcurrency?: number;
      /** @deprecated Use the explicit automatic/manual limits instead. */
      concurrency?: number;
      onError?: (error: unknown, sessionId?: string) => void;
      getCacheStats?: () => Promise<CacheStats>;
      clearCache?: () => Promise<boolean>;
      waitForCacheWrites?: () => Promise<void>;
      beginCacheClear?: () => void;
      endCacheClear?: () => void;
    },
  ) {}

  invalidateSession(sessionId: string | null | undefined): void {
    if (!isNonEmptyString(sessionId)) return;
    this.invalidatedVersions.set(sessionId, (this.invalidatedVersions.get(sessionId) ?? 0) + 1);
    if (this.manifestInFlight) this.reconcileRequested = true;
  }

  get pendingSessionIds(): string[] {
    return [...this.invalidatedVersions.keys()].sort();
  }

  getActiveSessionId(): string | null {
    return this.dependencies.getActiveSessionId();
  }

  reconcile(): Promise<boolean> {
    if (this.manifestInFlight) {
      this.reconcileRequested = true;
      return this.manifestInFlight;
    }
    const run = this.enqueueOperation(() => this.reconcileManifest());
    this.manifestInFlight = run;
    void run.finally(() => {
      if (this.manifestInFlight !== run) return;
      this.manifestInFlight = null;
      if (this.reconcileRequested) {
        this.reconcileRequested = false;
        void this.reconcile();
      }
    });
    return run;
  }

  /**
   * Force every history-ready manifest row through complete-history sync. This
   * deliberately does not use cached revisions as a reason to skip work.
   */
  forceSync(): Promise<SessionCacheForceSyncResult> {
    return this.enqueueOperation(async () => {
      let manifest: readonly SessionCacheManifestEntry[] | null;
      try {
        manifest = await this.dependencies.fetchManifest();
      } catch (error) {
        this.dependencies.onError?.(error);
        return {
          eligible: 0,
          succeeded: 0,
          failed: 0,
          success: false,
          manifestValid: false,
        };
      }

      if (!manifest) {
        return {
          eligible: 0,
          succeeded: 0,
          failed: 0,
          success: false,
          manifestValid: false,
        };
      }

      return this.synchronizeManifest(manifest, true);
    });
  }

  /** Serialize destructive clearing after synchronization and cache writes. */
  clearCache(): Promise<SessionCacheClearResult> {
    return this.enqueueOperation(async () => {
      const emptyStats: CacheStats = { sessionCount: 0, messageCount: 0 };
      this.dependencies.beginCacheClear?.();
      try {
        await this.dependencies.waitForCacheWrites?.();
        let clearSucceeded = false;
        try {
          clearSucceeded = (await this.dependencies.clearCache?.()) === true;
        } catch (error) {
          this.dependencies.onError?.(error);
        }
        // New writes are blocked by beginCacheClear until after this read, so
        // the result is the account's state at the destructive boundary.
        let stats = emptyStats;
        let statsReadSucceeded = true;
        try {
          stats = await (this.dependencies.getCacheStats?.() ?? Promise.resolve(emptyStats));
        } catch (error) {
          statsReadSucceeded = false;
          this.dependencies.onError?.(error);
        }
        return {
          success: clearSucceeded && statsReadSucceeded && stats.sessionCount === 0 && stats.messageCount === 0,
          stats,
        };
      } finally {
        this.dependencies.endCacheClear?.();
      }
    });
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.operationActive) {
      this.operationActive = true;
      let run: Promise<T>;
      try {
        // Start the first operation synchronously. Besides avoiding an
        // unnecessary tick, this lets callers observe an in-flight manifest
        // request immediately when they schedule automatic reconciliation.
        run = operation();
      } catch (error) {
        run = Promise.reject(error);
      }
      const completion = run.then(
        () => { if (this.operationTail === completion) this.operationActive = false; },
        () => { if (this.operationTail === completion) this.operationActive = false; },
      );
      this.operationTail = completion;
      return run;
    }

    const run = this.operationTail.then(operation, operation);
    const completion = run.then(
      () => { if (this.operationTail === completion) this.operationActive = false; },
      () => { if (this.operationTail === completion) this.operationActive = false; },
    );
    this.operationTail = completion;
    return run;
  }

  private async reconcileManifest(): Promise<boolean> {
    let manifest: readonly SessionCacheManifestEntry[] | null;
    try {
      manifest = await this.dependencies.fetchManifest();
    } catch (error) {
      this.dependencies.onError?.(error);
      return false;
    }
    if (!manifest) return false;

    return (await this.synchronizeManifest(manifest, false)).success;
  }

  private async synchronizeManifest(
    manifest: readonly SessionCacheManifestEntry[],
    forceAll: boolean,
  ): Promise<SessionCacheForceSyncResult> {
    let operationSuccessful = true;

    // Cleanup is deliberately after strict manifest validation/fetch success.
    try {
      await this.dependencies.cleanupCache(manifest);
    } catch (error) {
      operationSuccessful = false;
      this.dependencies.onError?.(error);
    }

    // Force-all work includes every history-ready row regardless of its cached
    // revision. Avoid opening one IndexedDB metadata read per manifest row when
    // those values cannot affect the plan.
    const cachedMetadata = new Map<string, SessionSyncMetadata | null>();
    if (!forceAll) {
      await Promise.all(manifest.map(async (entry) => {
        try {
          cachedMetadata.set(entry.sessionId, await this.dependencies.getCachedMetadata(entry.sessionId));
        } catch (error) {
          this.dependencies.onError?.(error, entry.sessionId);
          cachedMetadata.set(entry.sessionId, null);
        }
      }));
    }

    const concurrency = this.concurrencyFor(forceAll);

    // A history-less app-created session is still represented in IndexedDB by
    // metadata. Do not mark history-ready rows before canonical sync succeeds.
    const metadataResults = await runWithConcurrency(
      manifest.filter((entry) => !entry.historyReady),
      concurrency,
      async (entry) => {
        const version = this.invalidatedVersions.get(entry.sessionId) ?? 0;
        try {
          const result = await this.dependencies.recordSessionMetadata(entry.sessionId, this.metadataFor(entry));
          this.clearInvalidationIfCurrent(entry.sessionId, version);
          return result !== false;
        } catch (error) {
          this.dependencies.onError?.(error, entry.sessionId);
          return false;
        }
      },
    );
    if (metadataResults.some((result) => !result)) operationSuccessful = false;

    const plans = planSessionCacheSync({
      manifest,
      cachedMetadata,
      invalidatedSessionIds: new Set(this.invalidatedVersions.keys()),
      activeSessionId: this.dependencies.getActiveSessionId(),
      forceAll,
    });

    const syncResults = await runWithConcurrency(
      plans,
      concurrency,
      (plan) => this.synchronizePlan(plan),
    );
    const eligible = plans.length;
    const succeeded = syncResults.filter(Boolean).length;
    const failed = eligible - succeeded;
    return {
      eligible,
      succeeded,
      failed,
      success: operationSuccessful && failed === 0,
      manifestValid: true,
    };
  }

  private async synchronizePlan(plan: SessionCacheSyncPlan): Promise<boolean> {
    const sessionId = plan.entry.sessionId;
    const existing = this.inFlightSessions.get(sessionId);
    if (existing) return existing;

    const version = this.invalidatedVersions.get(sessionId) ?? 0;
    const task = (async () => {
      try {
        const result = await this.dependencies.synchronizeSession(sessionId, this.metadataFor(plan.entry));
        if (result && typeof result === 'object' && 'status' in result && result.status === 'error') {
          return false;
        }
        this.clearInvalidationIfCurrent(sessionId, version);
        return true;
      } catch (error) {
        this.dependencies.onError?.(error, sessionId);
        return false;
      }
    })();
    this.inFlightSessions.set(sessionId, task);
    try {
      return await task;
    } finally {
      if (this.inFlightSessions.get(sessionId) === task) this.inFlightSessions.delete(sessionId);
    }
  }

  private metadataFor(entry: SessionCacheManifestEntry): SessionSyncMetadata {
    return {
      revision: entry.revision,
      provider: entry.provider,
      archived: entry.archived,
      historyReady: entry.historyReady,
    };
  }

  private concurrencyFor(forceAll: boolean): number {
    if (forceAll) {
      return this.dependencies.manualConcurrency
        ?? MANUAL_CACHE_SYNC_CONCURRENCY;
    }
    return this.dependencies.automaticConcurrency
      ?? this.dependencies.concurrency
      ?? AUTOMATIC_CACHE_SYNC_CONCURRENCY;
  }

  private clearInvalidationIfCurrent(sessionId: string, version: number): void {
    if ((this.invalidatedVersions.get(sessionId) ?? 0) === version) {
      this.invalidatedVersions.delete(sessionId);
    }
  }
}

export function canRunSessionCacheSync(
  visibilityState: DocumentVisibilityState | string | undefined,
  online: boolean | undefined,
): boolean {
  return visibilityState !== 'hidden' && online !== false;
}
