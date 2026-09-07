import type { NormalizedMessage } from './normalizedMessage';

/**
 * Browser cache schema.
 *
 * Version 1 deliberately keeps messages and session metadata in separate
 * object stores. Every message is an individual record, keyed by namespace,
 * session, source, and stable message id. Future schema versions must add an
 * `oldVersion` branch in `onupgradeneeded` and preserve existing records; no
 * upgrade may destructively clear either store.
 */
export const SESSION_MESSAGE_CACHE_DB_NAME = 'cloudcli-session-message-cache';
export const SESSION_MESSAGE_CACHE_DB_VERSION = 1;
export const SESSION_MESSAGE_CACHE_MESSAGES_STORE = 'messages';
export const SESSION_MESSAGE_CACHE_METADATA_STORE = 'sessionMetadata';

export type MessageSource = 'server' | 'realtime';
export type CacheRevision = string | number | null;

export interface SessionSyncMetadata {
  canonicalRevision?: CacheRevision;
  revision?: CacheRevision;
  fetchedAt?: number | string | null;
  [key: string]: unknown;
}

export interface SessionManifestEntry {
  sessionId: string;
  revision?: CacheRevision;
}

export interface HydratedSession {
  sessionId: string;
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  /** All rows, deduplicated by id and sorted chronologically. */
  messages: NormalizedMessage[];
  metadata: SessionSyncMetadata | null;
}

export interface CachedSessionSummary {
  sessionId: string;
  metadata: SessionSyncMetadata | null;
}

export interface CacheStats {
  sessionCount: number;
  messageCount: number;
}

export type CacheFailureKind = 'none' | 'unsupported' | 'denied' | 'quota' | 'blocked' | 'open' | 'transaction';

export interface CacheStorageStatus {
  persistence: 'unknown' | 'unsupported' | 'granted' | 'denied';
  usage: number | null;
  quota: number | null;
  failure: CacheFailureKind;
}

export const EMPTY_CACHE_STORAGE_STATUS: CacheStorageStatus = {
  persistence: 'unknown', usage: null, quota: null, failure: 'none',
};

export function cacheStorageStatusesMatch(a: CacheStorageStatus, b: CacheStorageStatus): boolean {
  return a.persistence === b.persistence
    && a.usage === b.usage
    && a.quota === b.quota
    && a.failure === b.failure;
}

export interface ReplaceAuthoritativeSessionOptions {
  userNamespace: string;
  sessionId: string;
  serverMessages: readonly NormalizedMessage[];
  /** Rows received locally but not yet represented by the canonical response. */
  unreconciledRealtimeMessages?: readonly NormalizedMessage[];
  metadata?: SessionSyncMetadata | null;
}

export interface SessionMessageCacheOptions {
  dbName?: string;
  /** Injectable for tests and embedders that provide an IndexedDB implementation. */
  indexedDB?: IDBFactory | null;
}

interface StoredMessageRecord {
  userNamespace: string;
  sessionId: string;
  source: MessageSource;
  messageId: string;
  message: NormalizedMessage;
}

interface StoredMetadataRecord extends SessionSyncMetadata {
  userNamespace: string;
  sessionId: string;
}

const MESSAGE_INDEX_BY_USER_SESSION = 'byUserSession';
const MESSAGE_INDEX_BY_USER = 'byUser';
const METADATA_INDEX_BY_USER = 'byUser';

const NON_HISTORY_MESSAGE_KINDS = new Set<NormalizedMessage['kind']>([
  'complete',
  'status',
  'permission_request',
  'permission_cancelled',
  'session_created',
]);

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validMessage(message: unknown): message is NormalizedMessage {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Partial<NormalizedMessage>;
  return validIdentity(candidate.id)
    && validIdentity(candidate.sessionId)
    && validIdentity(candidate.timestamp)
    && validIdentity(candidate.provider)
    && validIdentity(candidate.kind);
}

function isPersistableMessage(message: NormalizedMessage): boolean {
  return !NON_HISTORY_MESSAGE_KINDS.has(message.kind);
}

function messageTime(message: NormalizedMessage): number | null {
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareMessages(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = messageTime(a);
  const timeB = messageTime(b);
  if (timeA !== null && timeB !== null && timeA !== timeB) return timeA - timeB;
  if (timeA === null && timeB !== null) return 1;
  if (timeA !== null && timeB === null) return -1;

  const sequenceA = a.seq ?? a.sequence ?? Number.POSITIVE_INFINITY;
  const sequenceB = b.seq ?? b.sequence ?? Number.POSITIVE_INFINITY;
  if (sequenceA !== sequenceB) return sequenceA - sequenceB;
  return a.id.localeCompare(b.id);
}

function sessionMessageKey(
  userNamespace: string,
  sessionId: string,
  source: MessageSource,
  messageId: string,
): IDBValidKey {
  return [userNamespace, sessionId, source, messageId];
}

function sessionKey(userNamespace: string, sessionId: string): IDBValidKey {
  return [userNamespace, sessionId];
}

function userNamespaceKeyRange(userNamespace: string): IDBKeyRange {
  // Compound keys for both stores start with the namespace. An array sorts
  // after the string session-id component, making it a bounded prefix sentinel.
  return IDBKeyRange.bound([userNamespace], [userNamespace, []]);
}

function recordMessage(
  userNamespace: string,
  sessionId: string,
  source: MessageSource,
  message: NormalizedMessage,
): StoredMessageRecord | null {
  if (!validMessage(message) || !isPersistableMessage(message)) return null;
  return {
    userNamespace,
    sessionId,
    source,
    messageId: message.id,
    // The operation's session is authoritative. This prevents a malformed
    // event from being stored under one session's key with another session id.
    message: { ...message, sessionId },
  };
}

function metadataFromRecord(record: StoredMetadataRecord | undefined): SessionSyncMetadata | null {
  if (!record) return null;
  const { userNamespace: _userNamespace, sessionId: _sessionId, ...metadata } = record;
  return metadata;
}

function manifestSessionId(entry: SessionManifestEntry | string): string | null {
  if (typeof entry === 'string') return validIdentity(entry) ? entry : null;
  return validIdentity(entry?.sessionId) ? entry.sessionId : null;
}

/**
 * Derive the namespace used by browser persistence without importing auth or
 * React. Callers should pass the authenticated identity, not a display name.
 */
export function getUserCacheNamespace(
  user: { id?: string | number | null; username?: string | null } | string | null | undefined,
): string | null {
  if (typeof user === 'string') return validIdentity(user) ? user : null;
  if (!user) return null;
  if (typeof user.id === 'number' && Number.isFinite(user.id)) return String(user.id);
  if (validIdentity(user.id)) return user.id;
  if (validIdentity(user.username)) return user.username;
  return null;
}

/** Request durable browser storage when the browser exposes that capability. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage || typeof storage.persist !== 'function') return false;
    return await storage.persist();
  } catch {
    return false;
  }
}

export async function inspectBrowserStorage(): Promise<CacheStorageStatus> {
  const storage = globalThis.navigator?.storage;
  if (!storage) return { ...EMPTY_CACHE_STORAGE_STATUS, persistence: 'unsupported', failure: 'unsupported' };
  let persistence: CacheStorageStatus['persistence'] = 'unsupported';
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    if (typeof storage.persisted === 'function') persistence = await storage.persisted() ? 'granted' : 'denied';
    if (typeof storage.estimate === 'function') {
      const estimate = await storage.estimate();
      usage = typeof estimate.usage === 'number' ? estimate.usage : null;
      quota = typeof estimate.quota === 'number' ? estimate.quota : null;
    }
    return { persistence, usage, quota, failure: persistence === 'denied' ? 'denied' : 'none' };
  } catch {
    return { persistence, usage, quota, failure: 'transaction' };
  }
}

function classifyStorageFailure(error: unknown, fallback: CacheFailureKind): CacheFailureKind {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return 'quota';
  if (name === 'InvalidStateError' || name === 'TransactionInactiveError' || name === 'AbortError') return 'transaction';
  return fallback;
}

export class SessionMessageCacheRepository {
  private readonly dbName: string;
  private readonly indexedDBFactory?: IDBFactory;
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private disabled = false;
  private failure: CacheFailureKind = 'none';

  constructor(options: SessionMessageCacheOptions = {}) {
    this.dbName = options.dbName ?? SESSION_MESSAGE_CACHE_DB_NAME;
    this.indexedDBFactory = options.indexedDB === undefined
      ? globalThis.indexedDB
      : options.indexedDB ?? undefined;
  }

  /** True after the repository has observed an unavailable or failed backend. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  get failureKind(): CacheFailureKind { return this.failure; }

  private recordFailure(error: unknown, fallback: CacheFailureKind): void {
    this.failure = classifyStorageFailure(error, fallback);
  }

  async requestPersistentStorage(): Promise<boolean> {
    return requestPersistentStorage();
  }

  private async openDatabase(): Promise<IDBDatabase | null> {
    if (this.disabled || !this.indexedDBFactory) {
      if (!this.indexedDBFactory) this.failure = 'unsupported';
      return null;
    }
    if (this.databasePromise) return this.databasePromise;

    this.databasePromise = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.indexedDBFactory!.open(this.dbName, SESSION_MESSAGE_CACHE_DB_VERSION);
      } catch (error) {
        this.recordFailure(error, 'open');
        this.disabled = true;
        resolve(null);
        return;
      }

      request.onupgradeneeded = () => {
        try {
          const database = request.result;
          // Upgrade branches are additive and intentionally do not clear data.
          if (!database.objectStoreNames.contains(SESSION_MESSAGE_CACHE_MESSAGES_STORE)) {
            const messages = database.createObjectStore(SESSION_MESSAGE_CACHE_MESSAGES_STORE, {
              keyPath: ['userNamespace', 'sessionId', 'source', 'messageId'],
            });
            messages.createIndex(MESSAGE_INDEX_BY_USER_SESSION, ['userNamespace', 'sessionId']);
            messages.createIndex(MESSAGE_INDEX_BY_USER, 'userNamespace');
          }

          if (!database.objectStoreNames.contains(SESSION_MESSAGE_CACHE_METADATA_STORE)) {
            const metadata = database.createObjectStore(SESSION_MESSAGE_CACHE_METADATA_STORE, {
              keyPath: ['userNamespace', 'sessionId'],
            });
            metadata.createIndex(METADATA_INDEX_BY_USER, 'userNamespace');
          }
        } catch {
          // The open request's error handler marks this repository unavailable.
          request.transaction?.abort();
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.recordFailure(request.error, 'open');
        this.disabled = true;
        resolve(null);
      };

      // A blocked upgrade should not hold chat hostage. Persistence is
      // optional, so disable this repository until a later instance retries.
      request.onblocked = () => {
        this.failure = 'blocked';
        this.disabled = true;
        resolve(null);
      };
    }).then((database) => {
      if (!database) {
        this.disabled = true;
        return null;
      }
      database.onversionchange = () => database.close();
      return database;
    });

    return this.databasePromise;
  }

  private async readSessionRecords(
    userNamespace: string,
    sessionId: string,
  ): Promise<{ messages: StoredMessageRecord[]; metadata: StoredMetadataRecord | undefined } | null> {
    const database = await this.openDatabase();
    if (!database) return null;

    try {
      const transaction = database.transaction(
        [SESSION_MESSAGE_CACHE_MESSAGES_STORE, SESSION_MESSAGE_CACHE_METADATA_STORE],
        'readonly',
      );
      const complete = transactionComplete(transaction);
      const messagesRequest = transaction
        .objectStore(SESSION_MESSAGE_CACHE_MESSAGES_STORE)
        .index(MESSAGE_INDEX_BY_USER_SESSION)
        .getAll([userNamespace, sessionId]);
      const metadataRequest = transaction
        .objectStore(SESSION_MESSAGE_CACHE_METADATA_STORE)
        .get(sessionKey(userNamespace, sessionId));
      const [messages, metadata] = await Promise.all([
        requestResult(messagesRequest),
        requestResult(metadataRequest),
      ]);
      await complete;
      return { messages, metadata };
    } catch (error) {
      this.recordFailure(error, 'transaction');
      return null;
    }
  }

  async hydrateSession(userNamespace: string, sessionId: string): Promise<HydratedSession | null> {
    if (!validIdentity(userNamespace) || !validIdentity(sessionId)) return null;
    const records = await this.readSessionRecords(userNamespace, sessionId);
    if (!records) return null;
    if (records.messages.length === 0 && !records.metadata) return null;

    const serverMessages = records.messages
      .filter((record) => record.source === 'server' && validMessage(record.message))
      .map((record) => record.message)
      .sort(compareMessages);
    const realtimeMessages = records.messages
      .filter((record) => record.source === 'realtime' && validMessage(record.message))
      .map((record) => record.message)
      .sort(compareMessages);

    const byId = new Map<string, NormalizedMessage>();
    for (const message of [...serverMessages, ...realtimeMessages]) {
      // Canonical server rows win when a realtime event shares an id.
      if (!byId.has(message.id) || serverMessages.some((server) => server.id === message.id)) {
        byId.set(message.id, message);
      }
    }
    const messages = [...byId.values()].sort(compareMessages);
    return {
      sessionId,
      serverMessages,
      realtimeMessages,
      messages,
      metadata: metadataFromRecord(records.metadata),
    };
  }

  async replaceAuthoritativeSession(options: ReplaceAuthoritativeSessionOptions): Promise<boolean> {
    const {
      userNamespace,
      sessionId,
      serverMessages,
      unreconciledRealtimeMessages = [],
      metadata,
    } = options;
    if (!validIdentity(userNamespace) || !validIdentity(sessionId)) return false;
    const database = await this.openDatabase();
    if (!database) return false;

    const serverRecords = serverMessages
      .map((message) => recordMessage(userNamespace, sessionId, 'server', message))
      .filter((record): record is StoredMessageRecord => record !== null);
    const serverIds = new Set(serverRecords.map((record) => record.messageId));
    const realtimeRecords = unreconciledRealtimeMessages
      .map((message) => recordMessage(userNamespace, sessionId, 'realtime', message))
      .filter((record): record is StoredMessageRecord => record !== null)
      .filter((record) => !serverIds.has(record.messageId));

    try {
      const transaction = database.transaction(
        [SESSION_MESSAGE_CACHE_MESSAGES_STORE, SESSION_MESSAGE_CACHE_METADATA_STORE],
        'readwrite',
      );
      const messagesStore = transaction.objectStore(SESSION_MESSAGE_CACHE_MESSAGES_STORE);
      const metadataStore = transaction.objectStore(SESSION_MESSAGE_CACHE_METADATA_STORE);
      const cursorRequest = messagesStore
        .index(MESSAGE_INDEX_BY_USER_SESSION)
        .openCursor([userNamespace, sessionId]);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
          return;
        }
        for (const record of [...serverRecords, ...realtimeRecords]) {
          messagesStore.put(record);
        }
        if (metadata === null) {
          metadataStore.delete(sessionKey(userNamespace, sessionId));
        } else if (metadata !== undefined) {
          metadataStore.put({ ...metadata, userNamespace, sessionId });
        }
      };
      cursorRequest.onerror = () => transaction.abort();
      await transactionComplete(transaction);
      return true;
    } catch (error) {
      this.recordFailure(error, 'transaction');
      return false;
    }
  }

  /** Positional convenience form for callers that do not need an options object. */
  async replaceSession(
    userNamespace: string,
    sessionId: string,
    serverMessages: readonly NormalizedMessage[],
    unreconciledRealtimeMessages: readonly NormalizedMessage[] = [],
    metadata?: SessionSyncMetadata | null,
  ): Promise<boolean> {
    return this.replaceAuthoritativeSession({
      userNamespace,
      sessionId,
      serverMessages,
      unreconciledRealtimeMessages,
      metadata,
    });
  }

  async upsertRealtimeMessage(
    userNamespace: string,
    sessionId: string,
    message: NormalizedMessage,
  ): Promise<boolean> {
    if (!validIdentity(userNamespace) || !validIdentity(sessionId)) return false;
    const record = recordMessage(userNamespace, sessionId, 'realtime', message);
    if (!record) return false;
    const database = await this.openDatabase();
    if (!database) return false;

    try {
      const transaction = database.transaction(
        [SESSION_MESSAGE_CACHE_MESSAGES_STORE, SESSION_MESSAGE_CACHE_METADATA_STORE],
        'readwrite',
      );
      transaction.objectStore(SESSION_MESSAGE_CACHE_MESSAGES_STORE).put(record);
      const metadataStore = transaction.objectStore(SESSION_MESSAGE_CACHE_METADATA_STORE);
      const metadataRequest = metadataStore.get(sessionKey(userNamespace, sessionId));
      metadataRequest.onsuccess = () => {
        if (!metadataRequest.result) {
          metadataStore.put({ userNamespace, sessionId });
        }
      };
      metadataRequest.onerror = () => transaction.abort();
      await transactionComplete(transaction);
      return true;
    } catch (error) {
      this.recordFailure(error, 'transaction');
      return false;
    }
  }

  async deleteRealtimeMessage(userNamespace: string, sessionId: string, messageId: string): Promise<boolean> {
    return this.deleteMessage(userNamespace, sessionId, 'realtime', messageId);
  }

  async deleteMessage(
    userNamespace: string,
    sessionId: string,
    source: MessageSource,
    messageId: string,
  ): Promise<boolean> {
    if (!validIdentity(userNamespace) || !validIdentity(sessionId) || !validIdentity(messageId)) return false;
    const database = await this.openDatabase();
    if (!database) return false;
    try {
      const transaction = database.transaction(SESSION_MESSAGE_CACHE_MESSAGES_STORE, 'readwrite');
      transaction.objectStore(SESSION_MESSAGE_CACHE_MESSAGES_STORE).delete(
        sessionMessageKey(userNamespace, sessionId, source, messageId),
      );
      await transactionComplete(transaction);
      return true;
    } catch {
      return false;
    }
  }

  async setSessionMetadata(
    userNamespace: string,
    sessionId: string,
    metadata: SessionSyncMetadata,
  ): Promise<boolean> {
    if (!validIdentity(userNamespace) || !validIdentity(sessionId)) return false;
    const database = await this.openDatabase();
    if (!database) return false;
    try {
      const transaction = database.transaction(SESSION_MESSAGE_CACHE_METADATA_STORE, 'readwrite');
      transaction.objectStore(SESSION_MESSAGE_CACHE_METADATA_STORE).put({
        ...metadata,
        userNamespace,
        sessionId,
      });
      await transactionComplete(transaction);
      return true;
    } catch {
      return false;
    }
  }

  async getSessionMetadata(userNamespace: string, sessionId: string): Promise<SessionSyncMetadata | null> {
    if (!validIdentity(userNamespace) || !validIdentity(sessionId)) return null;
    const database = await this.openDatabase();
    if (!database) return null;
    try {
      const transaction = database.transaction(SESSION_MESSAGE_CACHE_METADATA_STORE, 'readonly');
      const complete = transactionComplete(transaction);
      const request = transaction.objectStore(SESSION_MESSAGE_CACHE_METADATA_STORE).get(
        sessionKey(userNamespace, sessionId),
      );
      const record = await requestResult(request);
      await complete;
      return metadataFromRecord(record);
    } catch {
      return null;
    }
  }

  async getSessionRevision(userNamespace: string, sessionId: string): Promise<CacheRevision> {
    const metadata = await this.getSessionMetadata(userNamespace, sessionId);
    return metadata?.revision ?? null;
  }

  async listSessions(userNamespace: string): Promise<CachedSessionSummary[]> {
    if (!validIdentity(userNamespace)) return [];
    const database = await this.openDatabase();
    if (!database) return [];
    try {
      const transaction = database.transaction(
        [SESSION_MESSAGE_CACHE_MESSAGES_STORE, SESSION_MESSAGE_CACHE_METADATA_STORE],
        'readonly',
      );
      const complete = transactionComplete(transaction);
      const messageKeysRequest = transaction
        .objectStore(SESSION_MESSAGE_CACHE_MESSAGES_STORE)
        .index(MESSAGE_INDEX_BY_USER)
        .getAllKeys(userNamespace);
      const metadataRequest = transaction
        .objectStore(SESSION_MESSAGE_CACHE_METADATA_STORE)
        .index(METADATA_INDEX_BY_USER)
        .getAll(userNamespace);
      const [messageKeys, metadataRecords] = await Promise.all([
        requestResult(messageKeysRequest),
        requestResult(metadataRequest),
      ]);
      await complete;

      const metadataBySession = new Map<string, StoredMetadataRecord>();
      for (const record of metadataRecords) {
        if (validIdentity(record.sessionId)) metadataBySession.set(record.sessionId, record);
      }
      const sessionIds = new Set<string>(metadataBySession.keys());
      for (const key of messageKeys) {
        if (Array.isArray(key) && validIdentity(key[1])) sessionIds.add(key[1]);
      }
      return [...sessionIds]
        .sort()
        .map((sessionId) => ({
          sessionId,
          metadata: metadataFromRecord(metadataBySession.get(sessionId)),
        }));
    } catch {
      return [];
    }
  }

  async listSessionIds(userNamespace: string): Promise<string[]> {
    const sessions = await this.listSessions(userNamespace);
    return sessions.map((session) => session.sessionId);
  }

  async getCacheStats(userNamespace: string): Promise<CacheStats> {
    const emptyStats: CacheStats = { sessionCount: 0, messageCount: 0 };
    if (!validIdentity(userNamespace)) return emptyStats;
    const database = await this.openDatabase();
    if (!database) return emptyStats;

    try {
      const transaction = database.transaction(
        [SESSION_MESSAGE_CACHE_MESSAGES_STORE, SESSION_MESSAGE_CACHE_METADATA_STORE],
        'readonly',
      );
      const complete = transactionComplete(transaction);
      const messagesIndex = transaction
        .objectStore(SESSION_MESSAGE_CACHE_MESSAGES_STORE)
        .index(MESSAGE_INDEX_BY_USER);
      const messageCountRequest = messagesIndex.count(userNamespace);
      const messageKeysRequest = messagesIndex.getAllKeys(userNamespace);
      const metadataRequest = transaction
        .objectStore(SESSION_MESSAGE_CACHE_METADATA_STORE)
        .index(METADATA_INDEX_BY_USER)
        .getAll(userNamespace);
      const [messageCount, messageKeys, metadataRecords] = await Promise.all([
        requestResult(messageCountRequest),
        requestResult(messageKeysRequest),
        requestResult(metadataRequest),
      ]);
      await complete;

      const sessionIds = new Set<string>();
      for (const key of messageKeys) {
        if (Array.isArray(key) && validIdentity(key[1])) sessionIds.add(key[1]);
      }
      for (const record of metadataRecords) {
        if (validIdentity(record.sessionId)) sessionIds.add(record.sessionId);
      }
      return { sessionCount: sessionIds.size, messageCount };
    } catch {
      return emptyStats;
    }
  }

  async clearUserCache(userNamespace: string): Promise<boolean> {
    if (!validIdentity(userNamespace)) return false;
    const database = await this.openDatabase();
    if (!database) return false;

    try {
      const transaction = database.transaction(
        [SESSION_MESSAGE_CACHE_MESSAGES_STORE, SESSION_MESSAGE_CACHE_METADATA_STORE],
        'readwrite',
      );
      const range = userNamespaceKeyRange(userNamespace);
      transaction.objectStore(SESSION_MESSAGE_CACHE_MESSAGES_STORE).delete(range);
      transaction.objectStore(SESSION_MESSAGE_CACHE_METADATA_STORE).delete(range);
      await transactionComplete(transaction);
      return true;
    } catch {
      return false;
    }
  }

  async removeSession(userNamespace: string, sessionId: string): Promise<boolean> {
    if (!validIdentity(userNamespace) || !validIdentity(sessionId)) return false;
    const database = await this.openDatabase();
    if (!database) return false;
    try {
      const transaction = database.transaction(
        [SESSION_MESSAGE_CACHE_MESSAGES_STORE, SESSION_MESSAGE_CACHE_METADATA_STORE],
        'readwrite',
      );
      const messagesStore = transaction.objectStore(SESSION_MESSAGE_CACHE_MESSAGES_STORE);
      const cursorRequest = messagesStore
        .index(MESSAGE_INDEX_BY_USER_SESSION)
        .openCursor([userNamespace, sessionId]);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          transaction.objectStore(SESSION_MESSAGE_CACHE_METADATA_STORE).delete(
            sessionKey(userNamespace, sessionId),
          );
        }
      };
      cursorRequest.onerror = () => transaction.abort();
      await transactionComplete(transaction);
      return true;
    } catch {
      return false;
    }
  }

  async removeSessionsNotInManifest(
    userNamespace: string,
    manifest: readonly (SessionManifestEntry | string)[],
  ): Promise<string[]> {
    if (!Array.isArray(manifest) || !validIdentity(userNamespace)) return [];
    const manifestIds = new Set<string>();
    for (const entry of manifest) {
      const sessionId = manifestSessionId(entry);
      if (!sessionId) return [];
      manifestIds.add(sessionId);
    }
    const existingIds = await this.listSessionIds(userNamespace);
    const removed: string[] = [];
    for (const sessionId of existingIds) {
      if (!manifestIds.has(sessionId) && await this.removeSession(userNamespace, sessionId)) {
        removed.push(sessionId);
      }
    }
    return removed;
  }

  async reconcileManifest(
    userNamespace: string,
    manifest: readonly (SessionManifestEntry | string)[],
  ): Promise<string[]> {
    return this.removeSessionsNotInManifest(userNamespace, manifest);
  }

  /** Return manifest rows that are missing or have a different cached revision. */
  async sessionsNeedingSync(
    userNamespace: string,
    manifest: readonly SessionManifestEntry[],
  ): Promise<SessionManifestEntry[]> {
    if (!Array.isArray(manifest) || !validIdentity(userNamespace)) return [];
    const sessions = await this.listSessions(userNamespace);
    const metadataBySession = new Map(sessions.map((session) => [session.sessionId, session.metadata]));
    return manifest.filter((entry) => {
      if (!validIdentity(entry?.sessionId) || entry.revision === undefined) return false;
      return metadataBySession.get(entry.sessionId)?.revision !== entry.revision;
    });
  }

  async close(): Promise<void> {
    const database = await this.databasePromise;
    database?.close();
    this.databasePromise = null;
  }
}
