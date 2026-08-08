import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { getProjectSessionsPage } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-with-sessions-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('project session summaries include the recorded model for first-render hydration', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/workspace/opencode-project';
    const sessionId = sessionsDb.createAppSession('session-1', 'opencode', projectPath);
    sessionsDb.setSessionModel(sessionId, 'cloudcli-openai/gpt-5.6-sol');
    sessionsDb.setSessionAgent(sessionId, 'Architect');
    const subagentSessionId = sessionsDb.createAppSession('session-2', 'opencode', projectPath);
    sessionsDb.setSessionModel(subagentSessionId, 'cloudcli-openai/gpt-5.6-luna');
    sessionsDb.setSessionAgent(subagentSessionId, 'Code');

    const project = projectsDb.getProjectPath(projectPath);
    assert.ok(project);

    const result = await getProjectSessionsPage(project.project_id);

    assert.equal(result.sessions.length, 2);
    const parentSession = result.sessions.find((session) => session.id === sessionId);
    const subagentSession = result.sessions.find((session) => session.id === subagentSessionId);
    assert.equal(parentSession?.provider, 'opencode');
    assert.equal(parentSession?.model, 'cloudcli-openai/gpt-5.6-sol');
    assert.equal(parentSession?.agent, 'Architect');
    assert.equal(subagentSession?.model, 'cloudcli-openai/gpt-5.6-luna');
    assert.equal(subagentSession?.agent, 'Code');
  });
});

test('pages roots by recursive activity and returns each root closure with root offsets', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/workspace/hierarchy-project';
    const old = '2025-01-01T00:00:00.000Z';
    const latest = '2025-01-03T00:00:00.000Z';

    sessionsDb.createSession('root-a-native', 'opencode', projectPath, 'Root A', old, old);
    sessionsDb.createSession('child-a-native', 'opencode', projectPath, 'Child A', old, latest, null, 'Code', 'root-a-native');
    sessionsDb.createSession('grandchild-a-native', 'opencode', projectPath, 'Grandchild A', old, old, null, 'Code', 'child-a-native');
    sessionsDb.createSession('root-b-native', 'opencode', projectPath, 'Root B', old, '2025-01-02T00:00:00.000Z');
    sessionsDb.createSession('orphan-native', 'opencode', projectPath, 'Orphan', old, old, null, 'Code', 'missing-native');

    const project = projectsDb.getProjectPath(projectPath);
    assert.ok(project);

    const firstPage = await getProjectSessionsPage(project.project_id, { limit: 1, offset: 0 });
    assert.deepEqual(firstPage.sessions.map((session) => session.id), [
      'root-a-native',
      'child-a-native',
      'grandchild-a-native',
    ]);
    assert.deepEqual(
      firstPage.sessions.map((session) => [session.id, session.parentSessionId]),
      [
        ['root-a-native', null],
        ['child-a-native', 'root-a-native'],
        ['grandchild-a-native', 'child-a-native'],
      ],
    );
    assert.equal(firstPage.sessionMeta.total, 5);
    assert.equal(firstPage.sessionMeta.rootTotal, 3);
    assert.equal(firstPage.sessionMeta.rootOffset, 0);
    assert.equal(firstPage.sessionMeta.nextOffset, 1);
    assert.equal(firstPage.sessionMeta.hasMore, true);

    const secondPage = await getProjectSessionsPage(project.project_id, {
      limit: 1,
      offset: firstPage.sessionMeta.nextOffset,
    });
    assert.deepEqual(secondPage.sessions.map((session) => session.id), ['root-b-native']);
    assert.equal(secondPage.sessionMeta.nextOffset, 2);
    assert.equal(secondPage.sessionMeta.hasMore, true);

    const finalPage = await getProjectSessionsPage(project.project_id, {
      limit: 1,
      offset: secondPage.sessionMeta.nextOffset,
    });
    assert.deepEqual(finalPage.sessions.map((session) => session.id), ['orphan-native']);
    assert.equal('parentSessionId' in (finalPage.sessions[0] ?? {}), false);
    assert.equal(finalPage.sessionMeta.nextOffset, 3);
    assert.equal(finalPage.sessionMeta.hasMore, false);
  });
});

test('project hydration omits unresolved parents but keeps authoritative roots explicit', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/workspace/tri-state-project';
    sessionsDb.createSession('root-native', 'opencode', projectPath, 'Root');
    sessionsDb.createSession(
      'unresolved-child-native',
      'opencode',
      projectPath,
      'Unresolved child',
      undefined,
      undefined,
      null,
      'Code',
      'missing-parent-native',
    );

    const project = projectsDb.getProjectPath(projectPath);
    assert.ok(project);
    const result = await getProjectSessionsPage(project.project_id, { limit: 20 });
    const root = result.sessions.find((session) => session.id === 'root-native');
    const child = result.sessions.find((session) => session.id === 'unresolved-child-native');

    assert.equal(root?.parentSessionId, null);
    assert.equal('parentSessionId' in (child ?? {}), false);
    assert.equal(JSON.stringify(result).includes('missing-parent-native'), false);
  });
});

test('project hydration maps persisted provider hierarchy to canonical app ids', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/workspace/provider-hierarchy-project';
    const rootId = sessionsDb.createAppSession('app-root', 'opencode', projectPath);
    const childId = sessionsDb.createAppSession('app-child', 'opencode', projectPath);
    const grandchildId = sessionsDb.createAppSession('app-grandchild', 'opencode', projectPath);
    sessionsDb.assignProviderSessionId(rootId, 'native-root');
    sessionsDb.assignProviderSessionId(childId, 'native-child');
    sessionsDb.assignProviderSessionId(grandchildId, 'native-grandchild');

    sessionsDb.createSession(
      'native-root',
      'opencode',
      projectPath,
      'Root',
      undefined,
      undefined,
      null,
      'Architect',
      null,
    );
    sessionsDb.createSession(
      'native-child',
      'opencode',
      projectPath,
      'Child',
      undefined,
      undefined,
      null,
      'Code',
      'native-root',
    );
    sessionsDb.createSession(
      'native-grandchild',
      'opencode',
      projectPath,
      'Grandchild',
      undefined,
      undefined,
      null,
      'Code',
      'native-child',
    );

    const project = projectsDb.getProjectPath(projectPath);
    assert.ok(project);
    const result = await getProjectSessionsPage(project.project_id);

    assert.deepEqual(
      result.sessions.map((session) => [session.id, session.parentSessionId]),
      [
        ['app-root', null],
        ['app-child', 'app-root'],
        ['app-grandchild', 'app-child'],
      ],
    );
    assert.equal(JSON.stringify(result).includes('native-root'), false);
    assert.equal(JSON.stringify(result).includes('native-child'), false);
    assert.equal(JSON.stringify(result).includes('native-grandchild'), false);
  });
});
