import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { buildSessionUpsertedEvent } from '@/modules/providers/index.js';
import { flushSessionWatcherUpdatesForTest } from '@/modules/providers/services/sessions-watcher.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { connectedClients } from '@/modules/websocket/index.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-details-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

test('getSessionDetailsById resolves the owning project for a disk-indexed session', async () => {
  await withIsolatedDatabase(() => {
    const projectPath = '/home/user/example-project';
    const sessionId = sessionsDb.createSession('provider-abc', 'claude', projectPath, 'My session');
    sessionsDb.setSessionModel(sessionId, 'claude-sonnet-4-6');
    sessionsDb.setSessionAgent(sessionId, 'Code');
    const projectRow = projectsDb.getProjectPath(projectPath);
    assert.ok(projectRow, 'project row should exist after createSession');

    const details = sessionsService.getSessionDetailsById(sessionId);

    assert.equal(details.sessionId, sessionId);
    assert.equal(details.provider, 'claude');
    assert.equal(details.model, 'claude-sonnet-4-6');
    assert.equal(details.agent, 'Code');
    assert.equal(details.summary, 'My session');
    assert.equal(details.isArchived, false);
    assert.ok(details.project, 'project should be resolved');
    assert.equal(details.project?.projectId, projectRow?.project_id);
    // Paths are normalized to platform separators when stored.
    assert.equal(details.project?.fullPath, normalizeProjectPath(projectPath));
  });
});

test('getSessionDetailsById falls back to the provider-native id and returns the canonical app id', async () => {
  await withIsolatedDatabase(() => {
    const projectPath = '/home/user/alias-project';
    const appSessionId = sessionsDb.createAppSession('app-session-1', 'claude', projectPath);
    sessionsDb.assignProviderSessionId(appSessionId, 'provider-native-1');

    const details = sessionsService.getSessionDetailsById('provider-native-1');

    assert.equal(details.sessionId, appSessionId);
    assert.equal(details.project?.fullPath, normalizeProjectPath(projectPath));
  });
});

test('details and archived session serializers expose canonical parent ids', async () => {
  await withIsolatedDatabase(() => {
    const projectPath = '/home/user/nested-project';
    sessionsDb.createSession('parent-native', 'opencode', projectPath, 'Parent');
    const childId = sessionsDb.createSession(
      'child-native',
      'opencode',
      projectPath,
      'Child',
      undefined,
      undefined,
      null,
      'Code',
      'parent-native',
    );

    const details = sessionsService.getSessionDetailsById(childId);
    assert.equal(details.parentSessionId, 'parent-native');

    sessionsDb.updateSessionIsArchived(childId, true);
    const archived = sessionsService.listArchivedSessions().find((session) => session.sessionId === childId);
    assert.equal(archived?.parentSessionId, 'parent-native');
  });
});

test('detail and archive serializers distinguish roots from unresolved parents', async () => {
  await withIsolatedDatabase(() => {
    const projectPath = '/home/user/tri-state-details';
    const rootId = sessionsDb.createSession('root-native', 'opencode', projectPath, 'Root');
    const childId = sessionsDb.createSession(
      'child-native',
      'opencode',
      projectPath,
      'Child',
      undefined,
      undefined,
      null,
      'Code',
      'missing-parent-native',
    );

    const rootDetails = sessionsService.getSessionDetailsById(rootId);
    const unresolvedDetails = sessionsService.getSessionDetailsById(childId);
    assert.equal(rootDetails.parentSessionId, null);
    assert.equal('parentSessionId' in unresolvedDetails, false);
    assert.equal(JSON.stringify(unresolvedDetails).includes('missing-parent-native'), false);

    sessionsDb.updateSessionIsArchived(childId, true);
    const archived = sessionsService.listArchivedSessions().find((session) => session.sessionId === childId);
    assert.ok(archived);
    assert.equal('parentSessionId' in archived, false);
    assert.equal(JSON.stringify(archived).includes('missing-parent-native'), false);
  });
});

test('watcher session upsert uses the same canonical relationship shape', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('parent-native', 'opencode', '/home/user/watcher-project');
    const childId = sessionsDb.createSession(
      'child-native',
      'opencode',
      '/home/user/watcher-project',
      'Child',
      undefined,
      undefined,
      null,
      'Code',
      'parent-native',
    );

    const serialized = await buildSessionUpsertedEvent(childId);
    assert.ok(serialized);
    const payload = JSON.parse(serialized) as Record<string, unknown>;
    assert.equal('providerSessionId' in payload, false);
    const session = payload.session as Record<string, unknown>;
    assert.equal(session.id, childId);
    assert.equal(session.parentSessionId, 'parent-native');
  });
});

test('watcher session upserts omit unresolved parents and keep roots explicit', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/home/user/watcher-tri-state';
    const rootId = sessionsDb.createSession('root-native', 'opencode', projectPath, 'Root');
    const childId = sessionsDb.createSession(
      'child-native',
      'opencode',
      projectPath,
      'Child',
      undefined,
      undefined,
      null,
      'Code',
      'parent-native-secret',
    );

    const rootPayload = JSON.parse(await buildSessionUpsertedEvent(rootId) as string) as Record<string, unknown>;
    const childPayload = JSON.parse(await buildSessionUpsertedEvent(childId) as string) as Record<string, unknown>;
    const rootSession = rootPayload.session as Record<string, unknown>;
    const childSession = childPayload.session as Record<string, unknown>;

    assert.equal(rootSession.parentSessionId, null);
    assert.equal('parentSessionId' in childSession, false);
    assert.equal(JSON.stringify(childPayload).includes('parent-native-secret'), false);
  });
});

test('watcher queue deduplicates affected session ids and excludes unrelated history', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/home/user/watcher-dedupe';
    sessionsDb.createSession('affected-native', 'opencode', projectPath, 'Affected');
    sessionsDb.createSession('unrelated-native', 'opencode', projectPath, 'Unrelated');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await flushSessionWatcherUpdatesForTest('opencode', [
      'affected-native',
      'affected-native',
    ]);

    const upserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.deepEqual(upserts.map((frame) => frame.sessionId), ['affected-native']);
    assert.equal(upserts.some((frame) => frame.sessionId === 'unrelated-native'), false);
  });
});

test('getSessionDetailsById throws SESSION_NOT_FOUND for unknown ids', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getSessionDetailsById('does-not-exist'),
      (error: unknown) => error instanceof AppError && error.code === 'SESSION_NOT_FOUND',
    );
  });
});
