import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * gateway writer forwards so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-registry-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('live events are remapped to the app session id and sequenced', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'provider-id-9', content: 'hello' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'provider-id-9', content: 'hello world' });

    assert.equal(connection.frames.length, 2);
    assert.equal(connection.frames[0]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[0]?.generation, 0);
    assert.equal(connection.frames[1]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[1]?.seq, 2);
  });
});

test('session_created is swallowed and persisted as the provider-id mapping', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-2', 'cursor', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-2',
      provider: 'cursor',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'cursor',
      sessionId: 'cursor-native-7',
      newSessionId: 'cursor-native-7',
    });

    // The provider-native event itself is never forwarded...
    const sessionUpserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.equal(sessionUpserts.length, 1);
    assert.equal(sessionUpserts[0]?.sessionId, 'app-run-2');
    assert.equal('providerSessionId' in (sessionUpserts[0] ?? {}), false);
    // ...but the canonical mapping is recorded and persisted in the database.
    assert.equal(run.providerSessionId, 'cursor-native-7');
    assert.equal(sessionsDb.getSessionById('app-run-2')?.provider_session_id, 'cursor-native-7');
  });
});

test('session upsert uses canonical ids and includes canonical parent metadata only', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('parent-native', 'opencode', '/workspace/demo');
    const childId = sessionsDb.createSession(
      'child-native',
      'opencode',
      '/workspace/demo',
      'Child',
      undefined,
      undefined,
      null,
      'Code',
      'parent-native',
    );
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: childId,
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'opencode',
      sessionId: 'child-native',
      newSessionId: 'child-native',
    });

    const upsert = connection.frames.find((frame) => frame.kind === 'session_upserted');
    assert.ok(upsert);
    assert.equal('providerSessionId' in upsert, false);
    const session = upsert.session as Record<string, unknown>;
    assert.equal(session.id, childId);
    assert.equal(session.parentSessionId, 'parent-native');
  });
});

test('assigning a parent mapping rebroadcasts only the parent and newly resolved children', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-parent', 'opencode', '/workspace/mapping-race');
    sessionsDb.createSession(
      'child-native',
      'opencode',
      '/workspace/mapping-race',
      'Child',
      undefined,
      undefined,
      null,
      'Code',
      'parent-native',
    );
    sessionsDb.createSession(
      'unrelated-native',
      'opencode',
      '/workspace/mapping-race',
      'Unrelated',
      undefined,
      undefined,
      null,
      'Code',
      'other-parent-native',
    );

    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-parent',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'opencode',
      sessionId: 'parent-native',
      newSessionId: 'parent-native',
    });
    await new Promise((resolve) => setImmediate(resolve));

    const upserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.deepEqual(upserts.map((frame) => frame.sessionId).sort(), ['app-parent', 'child-native']);
    const childUpsert = upserts.find((frame) => frame.sessionId === 'child-native');
    assert.equal((childUpsert?.session as Record<string, unknown>).parentSessionId, 'app-parent');
    assert.equal(JSON.stringify(upserts).includes('parent-native'), false);
    assert.equal(JSON.stringify(upserts).includes('other-parent-native'), false);
  });
});

test('chat run mapping upsert omits an unresolved parent relationship', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession(
      'child-native',
      'opencode',
      '/workspace/unresolved-run',
      'Child',
      undefined,
      undefined,
      null,
      'Code',
      'missing-parent-native',
    );
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'child-native',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'opencode',
      sessionId: 'child-native',
      newSessionId: 'child-native',
    });
    await new Promise((resolve) => setImmediate(resolve));

    const upsert = connection.frames.find((frame) => frame.kind === 'session_upserted');
    assert.ok(upsert);
    assert.equal('parentSessionId' in (upsert.session as Record<string, unknown>), false);
    assert.equal(JSON.stringify(upsert).includes('missing-parent-native'), false);
  });
});

test('complete marks the run finished and duplicate completes are dropped', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-3', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-3',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 0 });
    // Late duplicate from a killed runtime's exit handler.
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 1 });

    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.actualSessionId, 'app-run-3');
    assert.equal(chatRunRegistry.isProcessing('app-run-3'), false);

    // completeRun is also a no-op once the run already completed.
    chatRunRegistry.completeRun('app-run-3', { exitCode: 1 });
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

test('a finished run\'s safety net cannot complete the session\'s next run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-9', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-9', exitCode: 0 });

    // A queued message starts the next run before the first run's runtime
    // promise settles (the chat handler's `finally` hasn't executed yet).
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);

    // First run's safety net fires late: it must not touch the new run.
    chatRunRegistry.completeRunIfCurrent(firstRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);

    // The second run's own safety net still works while it is current.
    chatRunRegistry.completeRunIfCurrent(secondRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), false);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('listRunningRuns returns only currently running app sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-run-8', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const completedRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(completedRun);

    const runningRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-8',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(runningRun);

    chatRunRegistry.completeRun('app-run-7', { exitCode: 0 });

    const runningSessions = chatRunRegistry.listRunningRuns();
    assert.deepEqual(runningSessions.map((session) => session.sessionId), ['app-run-8']);
    assert.equal(runningSessions[0]?.provider, 'codex');
  });
});

test('replayEvents returns only events after the requested seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-4',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'c' });

    const replayed = chatRunRegistry.replayEvents('app-run-4', 1);
    assert.deepEqual(replayed.map((event) => event.content), ['b', 'c']);
    assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
  });
});

test('attachConnection additively fans the live stream out to open sockets', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'opencode', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5',
      provider: 'opencode',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'before' });

    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5', secondConnection), true);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });

    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before', 'after']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after']);

    chatRunRegistry.detachConnection(firstConnection);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'detached' });
    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before', 'after']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after', 'detached']);
  });
});

test('startRun rejects a second concurrent run for the same session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(first);

    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.equal(second, null);

    // After the run finishes a new one is allowed again.
    chatRunRegistry.completeRun('app-run-6', { exitCode: 0 });
    const third = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(third);
  });
});

test('detached runs retain generation, progress, replay, and fence late old callbacks', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('detached-generation', 'opencode', '/workspace/demo');
    const progress: number[] = [];
    const first = chatRunRegistry.startRun({
      appSessionId: 'detached-generation', provider: 'opencode', providerSessionId: null,
      connection: null, userId: null, generation: 7,
      onProgress: (generation) => progress.push(generation),
    });
    assert.ok(first);
    first.writer.send({ kind: 'text', provider: 'opencode', sessionId: 'native', content: 'buffered' });
    assert.deepEqual(progress, [7]);
    assert.equal(chatRunRegistry.listRunningRuns()[0]?.generation, 7);
    assert.equal(chatRunRegistry.replayEvents('detached-generation', 0)[0]?.content, 'buffered');
    first.writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'native', exitCode: 0 });

    const replacement = chatRunRegistry.startRun({
      appSessionId: 'detached-generation', provider: 'opencode', providerSessionId: null,
      connection: null, userId: null, generation: 8,
    });
    assert.ok(replacement);
    first.writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'native', exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('detached-generation'), true);
    assert.equal(chatRunRegistry.getRun('detached-generation')?.generation, 8);
  });
});

test('generation-aware replay snapshots current cursors and fences live boundary ordering', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('boundary-run', 'claude', '/workspace/demo');
    const original = new FakeConnection();
    const reconnecting = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'boundary-run', provider: 'claude', providerSessionId: null,
      connection: original, userId: null, generation: 11,
    });
    assert.ok(run);
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'native', content: 'one' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'native', content: 'two' });

    const snapshot = chatRunRegistry.beginSubscription('boundary-run', reconnecting, 11, 1);
    assert.deepEqual({ generation: snapshot.generation, lastSeq: snapshot.lastSeq,
      replayFromSeq: snapshot.replayFromSeq, replayToSeq: snapshot.replayToSeq,
      replayGap: snapshot.replayGap, refreshRequired: snapshot.refreshRequired }, {
      generation: 11, lastSeq: 2, replayFromSeq: 2, replayToSeq: 2,
      replayGap: false, refreshRequired: false,
    });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'native', content: 'three' });
    for (const event of snapshot.events) reconnecting.send(JSON.stringify(event));
    chatRunRegistry.finishSubscription('boundary-run', reconnecting);

    assert.deepEqual(reconnecting.frames.map((frame) => frame.seq), [2, 3]);
    assert.deepEqual(reconnecting.frames.map((frame) => frame.generation), [11, 11]);
    assert.deepEqual(original.frames.map((frame) => frame.seq), [1, 2, 3]);
  });
});

test('an older generation cursor replays a completely retained current generation from its beginning', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('rollover-run', 'codex', '/workspace/demo');
    const run = chatRunRegistry.startRun({
      appSessionId: 'rollover-run', provider: 'codex', providerSessionId: null,
      connection: null, userId: null, generation: 4,
    });
    assert.ok(run);
    run.writer.send({ kind: 'text', provider: 'codex', sessionId: 'native', content: 'new-one' });
    run.writer.send({ kind: 'text', provider: 'codex', sessionId: 'native', content: 'new-two' });

    const connection = new FakeConnection();
    const snapshot = chatRunRegistry.beginSubscription('rollover-run', connection, 3, 99);
    assert.equal(snapshot.refreshRequired, false);
    assert.equal(snapshot.replayGap, false);
    assert.deepEqual(snapshot.events.map((event) => event.seq), [1, 2]);
  });
});

test('truncated, completed, and unknown replay coverage explicitly requires REST', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('truncated-run', 'opencode', '/workspace/demo');
    const run = chatRunRegistry.startRun({
      appSessionId: 'truncated-run', provider: 'opencode', providerSessionId: null,
      connection: null, userId: null, generation: 2,
    });
    assert.ok(run);
    for (let index = 0; index < 5001; index += 1) {
      run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'native', content: String(index) });
    }
    const truncated = chatRunRegistry.beginSubscription('truncated-run', new FakeConnection(), 2, 0);
    assert.equal(truncated.replayGap, true);
    assert.equal(truncated.refreshRequired, true);
    assert.deepEqual(truncated.events, []);

    run.writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'native', exitCode: 0 });
    const completed = chatRunRegistry.beginSubscription('truncated-run', new FakeConnection(), 2, 5001);
    assert.equal(completed.isProcessing, false);
    assert.equal(completed.refreshRequired, true);

    const unknown = chatRunRegistry.beginSubscription('missing-run', new FakeConnection(), undefined, 0);
    assert.equal(unknown.generation, null);
    assert.equal(unknown.replayGap, true);
    assert.equal(unknown.refreshRequired, true);
  });
});
