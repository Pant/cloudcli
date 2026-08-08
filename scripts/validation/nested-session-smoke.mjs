import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { buildSessionForest, flattenExpandedBranches } from '../../src/components/sidebar/utils/hierarchy.ts';

const cloudCliDatabaseSource = process.env.CLOUDCLI_SMOKE_CLOUD_DB
  ?? '/home/dev/.cloudcli/auth.db';
const openCodeDatabaseSource = process.env.CLOUDCLI_SMOKE_OPENCODE_DB
  ?? '/home/dev/.local/share/opencode/opencode.db';
const smokeRoot = await mkdtemp('/tmp/opencode/nested-session-smoke-');
const cloudCliDatabasePath = path.join(smokeRoot, 'cloudcli', 'auth.db');
const fixtureHome = path.join(smokeRoot, 'home');
const openCodeDatabasePath = path.join(fixtureHome, '.local', 'share', 'opencode', 'opencode.db');
const workspacePath = path.join(smokeRoot, 'workspace');
const nativeIds = {
  root: 'smoke-native-root',
  child: 'smoke-native-child',
  grandchild: 'smoke-native-grandchild',
};
const appIds = {
  root: 'smoke-app-root',
  child: 'smoke-app-child',
  grandchild: 'smoke-app-grandchild',
};

const copyDatabase = async (sourcePath, targetPath) => {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
};

const sanitizeOpenCodeFixture = () => {
  const db = new Database(openCodeDatabasePath);
  try {
    const columns = db.prepare('PRAGMA table_info(session)').all().map((column) => column.name);
    assert.ok(columns.includes('parent_id'), 'current OpenCode fixture must expose session.parent_id');

    db.transaction(() => {
      db.exec('DELETE FROM part');
      db.exec('DELETE FROM message');
      db.exec('DELETE FROM session');
      db.exec('DELETE FROM project');
      db.prepare(`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES (?, ?, ?, ?, ?)
      `).run('smoke-project', workspacePath, 1_800_000_000_000, 1_800_000_003_000, '[]');

      const insert = db.prepare(`
        INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version,
          agent, time_created, time_updated, time_archived
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `);
      insert.run(nativeIds.root, 'smoke-project', null, nativeIds.root, workspacePath, 'Smoke root', '0.0.0', 'Code', 1_800_000_000_000, 1_800_000_001_000);
      insert.run(nativeIds.child, 'smoke-project', nativeIds.root, nativeIds.child, workspacePath, 'Smoke child', '0.0.0', 'Code', 1_800_000_001_000, 1_800_000_002_000);
      insert.run(nativeIds.grandchild, 'smoke-project', nativeIds.child, nativeIds.grandchild, workspacePath, 'Smoke grandchild', '0.0.0', 'Code', 1_800_000_002_000, 1_800_000_003_000);
    })();
  } finally {
    db.close();
  }
};

const assertPreInitializationShape = () => {
  const db = new Database(cloudCliDatabasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
    assert.equal(columns.includes('provider_parent_session_id'), false);
    assert.throws(
      () => db.prepare('SELECT provider_parent_session_id FROM sessions LIMIT 1').get(),
      /no such column/i,
    );
    console.log('pre-initialization flat schema: confirmed missing provider_parent_session_id');
  } finally {
    db.close();
  }
};

const assertPostInitializationShape = () => {
  const db = new Database(cloudCliDatabasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
    assert.ok(columns.includes('provider_parent_session_id'));
    const marker = db.prepare("SELECT value FROM app_config WHERE key = 'opencode_hierarchy_backfill_version'").get();
    assert.equal(marker?.value, '1');
  } finally {
    db.close();
  }
};

const renderDepthMarkers = (sessions, projectId) => {
  const forest = buildSessionForest(sessions, projectId);
  const expanded = new Set(forest.nodes.keys());
  return flattenExpandedBranches(forest, expanded)
    .map((row) => `<div data-session-id="${row.id}" data-session-depth="${row.depth}"></div>`)
    .join('');
};

let closeConnection;
let restoreHome;

try {
  await copyDatabase(cloudCliDatabaseSource, cloudCliDatabasePath);
  await copyDatabase(openCodeDatabaseSource, openCodeDatabasePath);
  sanitizeOpenCodeFixture();
  assertPreInitializationShape();

  process.env.DATABASE_PATH = cloudCliDatabasePath;
  const originalHomeDir = os.homedir;
  os.homedir = () => fixtureHome;
  restoreHome = () => {
    os.homedir = originalHomeDir;
  };

  const database = await import('../../dist-server/server/modules/database/index.js');
  const { OpenCodeSessionSynchronizer } = await import('../../dist-server/server/modules/providers/list/opencode/opencode-session-synchronizer.provider.js');
  const projects = await import('../../dist-server/server/modules/projects/index.js');
  closeConnection = database.closeConnection;

  await database.initializeDatabase();
  assertPostInitializationShape();

  database.sessionsDb.createAppSession(appIds.root, 'opencode', workspacePath);
  database.sessionsDb.createAppSession(appIds.child, 'opencode', workspacePath);
  database.sessionsDb.createAppSession(appIds.grandchild, 'opencode', workspacePath);
  database.sessionsDb.assignProviderSessionId(appIds.root, nativeIds.root);
  database.sessionsDb.assignProviderSessionId(appIds.child, nativeIds.child);
  database.sessionsDb.assignProviderSessionId(appIds.grandchild, nativeIds.grandchild);

  const synchronized = await new OpenCodeSessionSynchronizer().synchronize();
  assert.equal(synchronized, 3);

  const project = database.projectsDb.getProjectPath(workspacePath);
  assert.ok(project, 'synchronization must hydrate the fixture project');
  const hydrated = await projects.getProjectSessionsPage(project.project_id);
  const hydratedEdges = new Map(hydrated.sessions.map((session) => [session.id, session.parentSessionId]));
  assert.deepEqual(hydratedEdges, new Map([
    [appIds.root, null],
    [appIds.child, appIds.root],
    [appIds.grandchild, appIds.child],
  ]));
  const serialized = JSON.stringify(hydrated);
  for (const nativeId of Object.values(nativeIds)) {
    assert.equal(serialized.includes(nativeId), false, `native id leaked: ${nativeId}`);
  }

  const rendered = renderDepthMarkers(hydrated.sessions, project.project_id);
  assert.match(rendered, new RegExp(`data-session-id="${appIds.root}" data-session-depth="0"`));
  assert.match(rendered, new RegExp(`data-session-id="${appIds.child}" data-session-depth="1"`));
  assert.match(rendered, new RegExp(`data-session-id="${appIds.grandchild}" data-session-depth="2"`));
  console.log(JSON.stringify({
    postMigration: { parentColumn: true, markerVersion: 1 },
    synchronized,
    canonicalEdges: [...hydratedEdges.entries()],
    renderedDepths: [0, 1, 2],
  }));
} finally {
  restoreHome?.();
  closeConnection?.();
  delete process.env.DATABASE_PATH;
  await rm(smokeRoot, { recursive: true, force: true });
}
