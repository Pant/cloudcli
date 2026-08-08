import assert from 'node:assert/strict';
import test from 'node:test';

import { IDBFactory } from 'fake-indexeddb';

import type { NormalizedMessage } from './normalizedMessage';
import {
  getUserCacheNamespace,
  SESSION_MESSAGE_CACHE_DB_VERSION,
  SESSION_MESSAGE_CACHE_MESSAGES_STORE,
  SESSION_MESSAGE_CACHE_METADATA_STORE,
  SessionMessageCacheRepository,
} from './sessionMessageCache';

function message(
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1',
    timestamp,
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: id,
    ...overrides,
  };
}

function createRepository(name: string): SessionMessageCacheRepository {
  return new SessionMessageCacheRepository({ dbName: name, indexedDB: new IDBFactory() });
}

test('creates the versioned message and metadata schema', async () => {
  const indexedDB = new IDBFactory();
  const repository = new SessionMessageCacheRepository({ dbName: 'cache-schema', indexedDB });
  assert.equal(SESSION_MESSAGE_CACHE_DB_VERSION, 1);
  assert.ok(await repository.replaceSession('user-a', 'session-1', [message('one', '2026-01-01T00:00:00Z')]));

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('cache-schema');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });

  const hydrated = await repository.hydrateSession('user-a', 'session-1');
  assert.deepEqual(hydrated?.messages.map((row) => row.id), ['one']);
  assert.equal(database.version, SESSION_MESSAGE_CACHE_DB_VERSION);
  assert.equal(database.objectStoreNames.contains(SESSION_MESSAGE_CACHE_MESSAGES_STORE), true);
  assert.equal(database.objectStoreNames.contains(SESSION_MESSAGE_CACHE_METADATA_STORE), true);
  database.close();
});

test('hydrates in chronological order and keeps users isolated', async () => {
  const repository = createRepository('cache-ordering');
  await repository.replaceSession('user-a', 'session-1', [
    message('late', '2026-01-01T00:00:03Z'),
    message('early', '2026-01-01T00:00:01Z'),
  ]);
  await repository.replaceSession('user-b', 'session-1', [message('other-user', '2026-01-01T00:00:00Z')]);

  const userA = await repository.hydrateSession('user-a', 'session-1');
  const userB = await repository.hydrateSession('user-b', 'session-1');
  assert.deepEqual(userA?.messages.map((row) => row.id), ['early', 'late']);
  assert.deepEqual(userB?.messages.map((row) => row.id), ['other-user']);
  assert.deepEqual(await repository.listSessionIds('user-a'), ['session-1']);
  assert.deepEqual(await repository.listSessionIds('user-b'), ['session-1']);
});

test('atomically replaces canonical rows while retaining specified realtime rows', async () => {
  const repository = createRepository('cache-replacement');
  await repository.replaceSession(
    'user-a',
    'session-1',
    [message('old-server', '2026-01-01T00:00:01Z')],
    [message('pending', '2026-01-01T00:00:02Z', { role: 'user' })],
  );

  assert.ok(await repository.replaceAuthoritativeSession({
    userNamespace: 'user-a',
    sessionId: 'session-1',
    serverMessages: [message('new-server', '2026-01-01T00:00:03Z')],
    unreconciledRealtimeMessages: [message('pending', '2026-01-01T00:00:02Z', { role: 'user' })],
  }));
  const hydrated = await repository.hydrateSession('user-a', 'session-1');
  assert.deepEqual(hydrated?.serverMessages.map((row) => row.id), ['new-server']);
  assert.deepEqual(hydrated?.realtimeMessages.map((row) => row.id), ['pending']);
});

test('realtime upsert is idempotent and replaces a streaming row', async () => {
  const repository = createRepository('cache-realtime');
  await repository.upsertRealtimeMessage('user-a', 'session-1', message('stream', '2026-01-01T00:00:01Z', {
    kind: 'stream_delta',
    content: 'partial',
  }));
  await repository.upsertRealtimeMessage('user-a', 'session-1', message('stream', '2026-01-01T00:00:02Z', {
    kind: 'stream_end',
    content: 'complete',
  }));

  const hydrated = await repository.hydrateSession('user-a', 'session-1');
  assert.equal(hydrated?.realtimeMessages.length, 1);
  assert.equal(hydrated?.realtimeMessages[0].content, 'complete');
  assert.equal(hydrated?.realtimeMessages[0].kind, 'stream_end');
});

test('deletes an individual realtime row without touching canonical server rows', async () => {
  const repository = createRepository('cache-realtime-delete');
  await repository.replaceSession('user-a', 'session-1', [message('server', '2026-01-01T00:00:00Z')], [
    message('realtime', '2026-01-01T00:00:01Z'),
  ]);
  assert.equal(await repository.deleteRealtimeMessage('user-a', 'session-1', 'realtime'), true);
  const hydrated = await repository.hydrateSession('user-a', 'session-1');
  assert.deepEqual(hydrated?.serverMessages.map((row) => row.id), ['server']);
  assert.deepEqual(hydrated?.realtimeMessages, []);
});

test('records metadata, identifies changed manifest revisions, and cleans absent sessions', async () => {
  const repository = createRepository('cache-metadata');
  await repository.replaceSession('user-a', 'session-1', [message('one', '2026-01-01T00:00:00Z')], [], {
    revision: 'rev-1',
    fetchedAt: 123,
  });
  await repository.replaceSession('user-a', 'session-2', [message('two', '2026-01-01T00:00:00Z')]);
  assert.deepEqual(await repository.getSessionMetadata('user-a', 'session-1'), {
    revision: 'rev-1',
    fetchedAt: 123,
  });
  assert.equal(await repository.getSessionRevision('user-a', 'session-1'), 'rev-1');
  assert.deepEqual(
    await repository.sessionsNeedingSync('user-a', [
      { sessionId: 'session-1', revision: 'rev-1' },
      { sessionId: 'session-2', revision: 'rev-2' },
      { sessionId: 'session-3', revision: 'rev-3' },
    ]),
    [
      { sessionId: 'session-2', revision: 'rev-2' },
      { sessionId: 'session-3', revision: 'rev-3' },
    ],
  );

  assert.deepEqual(await repository.reconcileManifest('user-a', [{ sessionId: 'session-1' }]), ['session-2']);
  assert.deepEqual(await repository.listSessionIds('user-a'), ['session-1']);
  assert.equal(await repository.getSessionMetadata('user-a', 'session-2'), null);
});

test('removes only the requested user session', async () => {
  const repository = createRepository('cache-cleanup');
  await repository.replaceSession('user-a', 'session-1', [message('a', '2026-01-01T00:00:00Z')]);
  await repository.replaceSession('user-b', 'session-1', [message('b', '2026-01-01T00:00:00Z')]);
  assert.equal(await repository.removeSession('user-a', 'session-1'), true);
  assert.equal(await repository.hydrateSession('user-a', 'session-1'), null);
  assert.deepEqual(await repository.hydrateSession('user-b', 'session-1')?.then((result) => result?.messages.map((row) => row.id)), ['b']);
});

test('derives stable user namespaces and fails open without IndexedDB or persistence APIs', async () => {
  assert.equal(getUserCacheNamespace({ id: 'id-1', username: 'name-1' }), 'id-1');
  assert.equal(getUserCacheNamespace({ username: 'name-1' }), 'name-1');
  assert.equal(getUserCacheNamespace(null), null);

  const repository = new SessionMessageCacheRepository({ indexedDB: null });
  assert.equal(await repository.hydrateSession('user-a', 'session-1'), null);
  assert.equal(await repository.replaceSession('user-a', 'session-1', [message('one', '2026-01-01T00:00:00Z')]), false);
  assert.deepEqual(await repository.listSessionIds('user-a'), []);
  assert.equal(await repository.requestPersistentStorage(), false);
});

test('does not persist control-only rows', async () => {
  const repository = createRepository('cache-control-frames');
  await repository.replaceSession('user-a', 'session-1', [
    message('visible', '2026-01-01T00:00:00Z'),
    message('complete', '2026-01-01T00:00:01Z', { kind: 'complete' }),
  ]);
  await repository.upsertRealtimeMessage('user-a', 'session-1', message('status', '2026-01-01T00:00:02Z', {
    kind: 'status',
  }));
  const hydrated = await repository.hydrateSession('user-a', 'session-1');
  assert.deepEqual(hydrated?.messages.map((row) => row.id), ['visible']);
});

test('returns exact stored message rows and metadata/message session counts', async () => {
  const repository = createRepository('cache-stats');
  await repository.replaceSession('user-a', 'session-1', [
    message('one', '2026-01-01T00:00:00Z'),
    message('two', '2026-01-01T00:00:01Z'),
  ]);
  await repository.replaceSession('user-a', 'session-2', [
    message('three', '2026-01-01T00:00:02Z', { sessionId: 'session-2' }),
  ], [], { total: 99 });
  assert.equal(await repository.setSessionMetadata('user-a', 'metadata-only', { historyReady: false }), true);
  await repository.replaceSession('user-b', 'other-session', [
    message('other', '2026-01-01T00:00:00Z'),
  ]);

  assert.deepEqual(await repository.getCacheStats('user-a'), {
    sessionCount: 3,
    messageCount: 3,
  });
  assert.deepEqual(await repository.getCacheStats('user-b'), {
    sessionCount: 1,
    messageCount: 1,
  });
});

test('clears one user namespace atomically and preserves other users', async () => {
  const repository = createRepository('cache-clear-user');
  await repository.replaceSession('user-a', 'session-1', [message('a-one', '2026-01-01T00:00:00Z')], [], {
    revision: 'a-revision',
  });
  await repository.setSessionMetadata('user-a', 'metadata-only', { historyReady: false });
  await repository.replaceSession('user-b', 'session-1', [message('b-one', '2026-01-01T00:00:00Z')], [], {
    revision: 'b-revision',
  });

  assert.equal(await repository.clearUserCache('user-a'), true);
  assert.deepEqual(await repository.getCacheStats('user-a'), { sessionCount: 0, messageCount: 0 });
  assert.deepEqual(await repository.listSessions('user-a'), []);
  assert.deepEqual(await repository.getCacheStats('user-b'), { sessionCount: 1, messageCount: 1 });
  assert.deepEqual(await repository.hydrateSession('user-b', 'session-1')?.then((result) => result?.messages.map((row) => row.id)), ['b-one']);
  assert.equal(await repository.getSessionMetadata('user-b', 'session-1').then((metadata) => metadata?.revision), 'b-revision');
});

test('clear and stats are safe to repeat and fail open for invalid or unavailable storage', async () => {
  const repository = createRepository('cache-clear-idempotent');
  await repository.replaceSession('user-a', 'session-1', [message('one', '2026-01-01T00:00:00Z')]);
  assert.equal(await repository.clearUserCache('user-a'), true);
  assert.equal(await repository.clearUserCache('user-a'), true);
  assert.deepEqual(await repository.getCacheStats('user-a'), { sessionCount: 0, messageCount: 0 });
  assert.deepEqual(await repository.getCacheStats(''), { sessionCount: 0, messageCount: 0 });
  assert.equal(await repository.clearUserCache(''), false);

  const unavailable = new SessionMessageCacheRepository({ indexedDB: null });
  assert.deepEqual(await unavailable.getCacheStats('user-a'), { sessionCount: 0, messageCount: 0 });
  assert.equal(await unavailable.clearUserCache('user-a'), false);
  assert.deepEqual(await unavailable.getCacheStats(''), { sessionCount: 0, messageCount: 0 });
});
