import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-mapping-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

test('disk-discovered sessions are keyed by the provider id for both columns', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('provider-abc', 'claude', '/workspace/demo', 'From Disk');

    const row = sessionsDb.getSessionById('provider-abc');
    assert.equal(row?.session_id, 'provider-abc');
    assert.equal(row?.provider_session_id, 'provider-abc');

    const byProviderId = sessionsDb.getSessionByProviderSessionId('provider-abc');
    assert.equal(byProviderId?.session_id, 'provider-abc');
  });
});

test('app sessions get the provider id assigned without creating a duplicate row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-id-1', 'provider-xyz');

    // A later synchronizer pass that discovers the transcript on disk must
    // update the app row in place instead of inserting a provider-keyed row.
    const returnedId = sessionsDb.createSession(
      'provider-xyz',
      'claude',
      '/workspace/demo',
      'Synced Name',
      undefined,
      undefined,
      '/fake/path/provider-xyz.jsonl',
    );

    assert.equal(returnedId, 'app-id-1');
    assert.equal(sessionsDb.getAllSessions().length, 1);

    const row = sessionsDb.getSessionById('app-id-1');
    assert.equal(row?.provider_session_id, 'provider-xyz');
    assert.equal(row?.jsonl_path, '/fake/path/provider-xyz.jsonl');
  });
});

test('assignProviderSessionId merges a watcher-created duplicate into the app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-2', 'codex', '/workspace/demo');

    // Simulate the race: the filesystem watcher indexed the provider
    // transcript before the runtime announced its session id to the gateway.
    sessionsDb.createSession(
      'provider-race',
      'codex',
      '/workspace/demo',
      'Watcher Name',
      undefined,
      undefined,
      '/fake/provider-race.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 2);

    sessionsDb.assignProviderSessionId('app-id-2', 'provider-race');

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session_id, 'app-id-2');
    assert.equal(rows[0]?.provider_session_id, 'provider-race');
    // Transcript path and name from the duplicate are adopted.
    assert.equal(rows[0]?.jsonl_path, '/fake/provider-race.jsonl');
    assert.equal(rows[0]?.custom_name, 'Watcher Name');
  });
});

test('legacy provider-keyed rows stay resolvable through both lookups', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-1', 'opencode', '/workspace/demo');

    assert.equal(sessionsDb.getSessionById('legacy-1')?.provider, 'opencode');
    assert.equal(sessionsDb.getSessionByProviderSessionId('legacy-1')?.session_id, 'legacy-1');
  });
});

test('pending app session mapping stays NULL across close and repeated initialization', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('pending-app-session', 'opencode', '/workspace/pending');
    assert.equal(sessionsDb.getSessionById('pending-app-session')?.provider_session_id, null);

    closeConnection();
    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById('pending-app-session')?.provider_session_id, null);

    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById('pending-app-session')?.provider_session_id, null);
  });
});

test('first provider mapping migration backfills legacy provider-keyed rows', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-legacy-mapping-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  const legacyDatabase = new Database(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      project_path TEXT,
      custom_name TEXT,
      jsonl_path TEXT,
      isArchived BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO sessions (session_id, provider, project_path)
    VALUES ('legacy-native-id', 'opencode', '/workspace/legacy');
  `);
  legacyDatabase.close();
  process.env.DATABASE_PATH = databasePath;

  try {
    await initializeDatabase();
    assert.equal(
      sessionsDb.getSessionById('legacy-native-id')?.provider_session_id,
      'legacy-native-id',
    );
    assert.equal(
      sessionsDb.getSessionByProviderSessionId('legacy-native-id')?.session_id,
      'legacy-native-id',
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('initialization repairs only UUID-shaped self-mapped OpenCode appointment sessions', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    db.prepare(`
      INSERT INTO projects (project_id, project_path)
      VALUES ('repair-project', '/workspace/repair')
    `).run();

    const rows = [
      ['11111111-1111-4111-8111-111111111111', 'opencode', '11111111-1111-4111-8111-111111111111'],
      ['22222222-2222-4222-8222-222222222222', 'opencode', 'ses_native_mapping'],
      ['33333333-3333-4333-8333-333333333333', 'claude', '33333333-3333-4333-8333-333333333333'],
      ['44444444-4444-4444-8444-444444444444', 'opencode', '44444444-4444-4444-8444-444444444444'],
      ['ses_legacy_native', 'opencode', 'ses_legacy_native'],
    ] as const;
    const insertSession = db.prepare(`
      INSERT INTO sessions (session_id, provider, provider_session_id, project_path)
      VALUES (?, ?, ?, '/workspace/repair')
    `);
    for (const row of rows) insertSession.run(...row);

    const insertAppointment = db.prepare(`
      INSERT INTO appointments (
        id, project_id, session_id, user_id, provider, prompt, trigger_type,
        is_active, status, created_at, updated_at
      ) VALUES (?, 'repair-project', ?, 'repair-user', ?, ?, 'queue', 1, ?, 100, 100)
    `);
    insertAppointment.run('repair-target', rows[0][0], 'opencode', 'deliver this exact prompt', 'scheduled');
    insertAppointment.run('mapped-native', rows[1][0], 'opencode', 'mapped prompt', 'running');
    insertAppointment.run('other-provider', rows[2][0], 'claude', 'claude prompt', 'draft');
    insertAppointment.run('non-uuid', rows[4][0], 'opencode', 'legacy prompt', 'needs_review');

    const appointmentsBefore = db.prepare(`
      SELECT id, session_id, status, prompt, updated_at
      FROM appointments
      ORDER BY id
    `).all();

    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById(rows[0][0])?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionById(rows[1][0])?.provider_session_id, rows[1][2]);
    assert.equal(sessionsDb.getSessionById(rows[2][0])?.provider_session_id, rows[2][2]);
    assert.equal(sessionsDb.getSessionById(rows[3][0])?.provider_session_id, rows[3][2]);
    assert.equal(sessionsDb.getSessionById(rows[4][0])?.provider_session_id, rows[4][2]);
    assert.deepEqual(db.prepare(`
      SELECT id, session_id, status, prompt, updated_at
      FROM appointments
      ORDER BY id
    `).all(), appointmentsBefore);

    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById(rows[0][0])?.provider_session_id, null);
    assert.deepEqual(db.prepare(`
      SELECT id, session_id, status, prompt, updated_at
      FROM appointments
      ORDER BY id
    `).all(), appointmentsBefore);
  });
});

test('provider-native parent ids resolve to canonical parent app ids', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('root-native', 'opencode', '/workspace/hierarchy', 'Root');
    sessionsDb.createSession(
      'child-native',
      'opencode',
      '/workspace/hierarchy',
      'Child',
      undefined,
      undefined,
      null,
      null,
      'root-native',
    );
    sessionsDb.createSession(
      'grandchild-native',
      'opencode',
      '/workspace/hierarchy',
      'Grandchild',
      undefined,
      undefined,
      null,
      null,
      'child-native',
    );

    assert.equal(sessionsDb.getSessionById('child-native')?.provider_parent_session_id, 'root-native');
    assert.equal(sessionsDb.getCanonicalParentSessionId('child-native'), 'root-native');
    assert.equal(sessionsDb.getCanonicalParentSessionId('grandchild-native'), 'child-native');
    assert.equal(sessionsDb.getCanonicalParentSessionId('root-native'), null);
  });
});

test('child-before-parent indexing resolves its canonical parent after the parent arrives', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'child-before-parent',
      'opencode',
      '/workspace/race',
      'Child',
      undefined,
      undefined,
      null,
      null,
      'parent-arrives-later',
    );
    assert.deepEqual(sessionsDb.getSessionParentResolution('child-before-parent'), {
      kind: 'unresolved',
      parentSessionId: undefined,
    });
    assert.equal(sessionsDb.getCanonicalParentSessionId('child-before-parent'), undefined);

    const unresolvedChildIds = sessionsDb.getUnresolvedChildrenForProviderParent(
      'opencode',
      'parent-arrives-later',
    );
    assert.deepEqual(unresolvedChildIds, ['child-before-parent']);
    sessionsDb.createSession('parent-arrives-later', 'opencode', '/workspace/race', 'Parent');
    assert.equal(
      sessionsDb.getCanonicalParentSessionId('child-before-parent'),
      'parent-arrives-later',
    );
  });
});

test('app-created parent mapping later resolves an already indexed child', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-parent-race', 'opencode', '/workspace/app-race');
    sessionsDb.createSession(
      'child-native-race',
      'opencode',
      '/workspace/app-race',
      'Child',
      undefined,
      undefined,
      null,
      null,
      'parent-native-race',
    );

    assert.equal(sessionsDb.getCanonicalParentSessionId('child-native-race'), undefined);
    assert.deepEqual(
      sessionsDb.assignProviderSessionId('app-parent-race', 'parent-native-race'),
      ['child-native-race'],
    );
    assert.equal(
      sessionsDb.getCanonicalParentSessionId('child-native-race'),
      'app-parent-race',
    );
  });
});

test('provider mapping reports only children whose canonical relationship changed', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-parent', 'opencode', '/workspace/affected');
    sessionsDb.createSession(
      'affected-child',
      'opencode',
      '/workspace/affected',
      'Affected',
      undefined,
      undefined,
      null,
      null,
      'parent-native',
    );
    sessionsDb.createSession(
      'unrelated-child',
      'opencode',
      '/workspace/affected',
      'Unrelated',
      undefined,
      undefined,
      null,
      null,
      'different-native-parent',
    );

    assert.deepEqual(sessionsDb.assignProviderSessionId('app-parent', 'parent-native'), ['affected-child']);
    assert.deepEqual(sessionsDb.assignProviderSessionId('app-parent', 'parent-native'), []);
    assert.equal(sessionsDb.getCanonicalParentSessionId('unrelated-child'), undefined);
    assert.equal(sessionsDb.getCanonicalParentSessionId('affected-child'), 'app-parent');
  });
});

test('changing a mapped provider id reports children that must detach and later reparent', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-parent', 'opencode', '/workspace/reparent');
    sessionsDb.assignProviderSessionId('app-parent', 'old-parent-native');
    sessionsDb.createSession(
      'old-child',
      'opencode',
      '/workspace/reparent',
      'Old child',
      undefined,
      undefined,
      null,
      null,
      'old-parent-native',
    );
    sessionsDb.createSession(
      'new-child',
      'opencode',
      '/workspace/reparent',
      'New child',
      undefined,
      undefined,
      null,
      null,
      'new-parent-native',
    );

    assert.deepEqual(
      new Set(sessionsDb.assignProviderSessionId('app-parent', 'new-parent-native')),
      new Set(['old-child', 'new-child']),
    );
    assert.deepEqual(sessionsDb.getSessionParentResolution('old-child'), {
      kind: 'unresolved',
      parentSessionId: undefined,
    });
    assert.equal(sessionsDb.getCanonicalParentSessionId('new-child'), 'app-parent');
  });
});

test('a synchronized child can move between resolved canonical parents', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-parent-a', 'opencode', '/workspace/resolved-reparent');
    sessionsDb.createAppSession('app-parent-b', 'opencode', '/workspace/resolved-reparent');
    sessionsDb.assignProviderSessionId('app-parent-a', 'parent-a-native');
    sessionsDb.assignProviderSessionId('app-parent-b', 'parent-b-native');
    sessionsDb.createSession(
      'child-native',
      'opencode',
      '/workspace/resolved-reparent',
      'Child',
      undefined,
      undefined,
      null,
      null,
      'parent-a-native',
    );
    assert.equal(sessionsDb.getCanonicalParentSessionId('child-native'), 'app-parent-a');

    sessionsDb.createSession(
      'child-native',
      'opencode',
      '/workspace/resolved-reparent',
      'Child',
      undefined,
      undefined,
      null,
      null,
      'parent-b-native',
    );
    assert.equal(sessionsDb.getCanonicalParentSessionId('child-native'), 'app-parent-b');
  });
});

test('duplicate provider mapping merges parent metadata without dropping it', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-parent', 'opencode', '/workspace/merge');
    sessionsDb.createSession(
      'provider-parent',
      'opencode',
      '/workspace/merge',
      'Watcher Parent',
      undefined,
      undefined,
      null,
      null,
      'provider-grandparent',
    );

    sessionsDb.assignProviderSessionId('app-parent', 'provider-parent');

    assert.equal(sessionsDb.getAllSessions().length, 1);
    assert.equal(
      sessionsDb.getSessionById('app-parent')?.provider_parent_session_id,
      'provider-grandparent',
    );
  });
});
