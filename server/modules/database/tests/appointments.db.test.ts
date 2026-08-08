import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { appointmentsDb, closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

async function withDatabase(runTest: (databasePath: string) => void | Promise<void>): Promise<void> {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'appointments-'));
  const databasePath = path.join(directory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  const db = getConnection();
  db.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?), (?, ?)').run('project-1', '/workspace/one', 'project-2', '/workspace/two');
  db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES (?, 'opencode', ?), (?, 'opencode', ?)").run('session-1', '/workspace/one', 'session-2', '/workspace/two');
  try {
    await runTest(databasePath);
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

function createAppointment(overrides: Partial<Parameters<typeof appointmentsDb.create>[0]> = {}) {
  return appointmentsDb.create({
    id: 'appointment-1', projectId: 'project-1', sessionId: 'session-1', userId: 'user-1',
    provider: 'opencode', prompt: 'Run the checks', triggerType: 'exact', dueAt: 2_000,
    isActive: true, now: 1_000,
    options: { model: 'model-a', effort: 'high', agent: 'build', permissionMode: 'ask', tools: { bash: true } },
    attachments: [{ path: '/assets/report.txt', name: 'report.txt', mimeType: 'text/plain', size: 42 }],
    ...overrides,
  });
}

test('fresh and upgraded databases contain the indexed appointment schema idempotently', async () => {
  await withDatabase(() => {
    const indexes = getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'appointments'").all() as Array<{ name: string }>;
    assert.deepEqual(indexes.map(({ name }) => name).filter((name) => name.startsWith('idx_')).sort(), [
      'idx_appointments_due', 'idx_appointments_project_idle', 'idx_appointments_project_user',
      'idx_appointments_queue_order', 'idx_appointments_running',
    ]);
  });
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT)');
    runMigrations(db); runMigrations(db);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'appointments'").get());
  } finally { db.close(); }
});

test('initializeDatabase upgrades appointments created before queue columns existed', async () => {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'appointments-legacy-'));
  const databasePath = path.join(directory, 'auth.db');
  closeConnection();
  const legacyDb = new Database(databasePath);
  legacyDb.exec(`
    CREATE TABLE appointments (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      prompt TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '{}',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('exact', 'timer', 'project_idle')),
      due_at INTEGER,
      timer_duration_ms INTEGER,
      project_idle_since INTEGER,
      is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'needs_review', 'running', 'completed', 'failed', 'cancelled')),
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      claimed_at INTEGER,
      completed_at INTEGER
    )
  `);
  legacyDb.close();
  process.env.DATABASE_PATH = databasePath;
  try {
    await initializeDatabase();
    const db = getConnection();
    const columns = db.prepare('PRAGMA table_info(appointments)').all() as Array<{ name: string }>;
    assert.ok(columns.some(({ name }) => name === 'queue_position'));
    assert.ok(columns.some(({ name }) => name === 'run_generation'));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_appointments_queue_order'").get());
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('queue rows append per scope, reorder exact mutable sets, and preserve running generations', async () => {
  await withDatabase(async () => {
    createAppointment({ id: 'queue-1', triggerType: 'queue', dueAt: null });
    createAppointment({ id: 'queue-2', triggerType: 'queue', dueAt: null, now: 1_001 });
    createAppointment({ id: 'other-user', triggerType: 'queue', dueAt: null, userId: 'user-2' });
    createAppointment({ id: 'other-project', triggerType: 'queue', dueAt: null, projectId: 'project-2', sessionId: 'session-2' });
    assert.deepEqual(appointmentsDb.listMutableQueue('project-1', 'user-1').map(({ id, queuePosition }) => [id, queuePosition]), [['queue-1', 1], ['queue-2', 2]]);
    assert.equal(appointmentsDb.reorderMutableQueue({ projectId: 'project-1', userId: 'user-1', appointmentIds: ['queue-1'] }), null);
    assert.equal(appointmentsDb.reorderMutableQueue({ projectId: 'project-1', userId: 'user-1', appointmentIds: ['queue-1', 'queue-1'] }), null);
    assert.deepEqual(appointmentsDb.reorderMutableQueue({ projectId: 'project-1', userId: 'user-1', appointmentIds: ['queue-2', 'queue-1'], now: 1_100 })?.map(({ id, queuePosition }) => [id, queuePosition]), [['queue-2', 1], ['queue-1', 2]]);
    assert.equal(appointmentsDb.claim('queue-2', 1_200)?.status, 'running');
    assert.equal(appointmentsDb.assignRunGeneration('queue-2', 7, 1_201), true);
    assert.deepEqual(appointmentsDb.listRunning().map(({ id, runGeneration }) => [id, runGeneration]), [['queue-2', 7]]);
    assert.deepEqual(appointmentsDb.listMutableQueue('project-1', 'user-1').map(({ id }) => id), ['queue-1']);
    closeConnection();
    await initializeDatabase();
    assert.equal(appointmentsDb.getById('queue-2', 'project-1', 'user-1')?.runGeneration, 7);
  });
});

test('legacy queue columns backfill deterministically and migration remains idempotent', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT)');
    runMigrations(db);
    db.exec("INSERT INTO projects (project_id, project_path) VALUES ('p', '/p'); INSERT INTO sessions (session_id, provider, project_path) VALUES ('s', 'opencode', '/p')");
    db.prepare("INSERT INTO appointments (id, project_id, session_id, user_id, provider, prompt, trigger_type, is_active, status, created_at, updated_at) VALUES (?, 'p', 's', 'u', 'opencode', 'x', 'queue', 1, 'scheduled', ?, ?)").run('later', 20, 20);
    db.prepare("INSERT INTO appointments (id, project_id, session_id, user_id, provider, prompt, trigger_type, is_active, status, created_at, updated_at) VALUES (?, 'p', 's', 'u', 'opencode', 'x', 'queue', 1, 'scheduled', ?, ?)").run('earlier', 10, 10);
    db.exec('UPDATE appointments SET queue_position = NULL');
    runMigrations(db); runMigrations(db);
    assert.deepEqual(db.prepare("SELECT id, queue_position FROM appointments WHERE trigger_type = 'queue' ORDER BY queue_position").all(), [{ id: 'earlier', queue_position: 1 }, { id: 'later', queue_position: 2 }]);
  } finally { db.close(); }
});

test('records retain scheduling payloads, survive reopen, and remain project/user scoped', async () => {
  await withDatabase(async () => {
    const created = createAppointment();
    assert.equal(created.prompt, 'Run the checks');
    assert.deepEqual(created.options.tools, { bash: true });
    assert.equal(created.attachments[0]?.name, 'report.txt');
    assert.equal(appointmentsDb.listByProject('project-1', 'user-1').length, 1);
    assert.equal(appointmentsDb.listByProject('project-2', 'user-1').length, 0);
    assert.equal(appointmentsDb.listByProject('project-1', 'user-2').length, 0);
    closeConnection();
    await initializeDatabase();
    assert.equal(appointmentsDb.getById('appointment-1', 'project-1', 'user-1')?.sessionId, 'session-1');
  });
});

test('activation, conditional transitions, due queries, and atomic claims are normalized', async () => {
  await withDatabase(() => {
    createAppointment();
    createAppointment({ id: 'idle', triggerType: 'project_idle', dueAt: null });
    assert.deepEqual(appointmentsDb.listDue(2_000).map(({ id }) => id), ['appointment-1']);
    assert.deepEqual(appointmentsDb.listProjectIdle().map(({ id }) => id), ['idle']);
    assert.equal(appointmentsDb.update('appointment-1', 'project-1', 'user-1', { isActive: false, now: 1_100 })?.status, 'draft');
    assert.equal(appointmentsDb.update('appointment-1', 'project-1', 'user-1', { isActive: true, now: 1_200 })?.status, 'scheduled');
    assert.equal(appointmentsDb.transition('appointment-1', 'draft', 'cancelled'), false);
    assert.equal(appointmentsDb.claim('appointment-1', 2_100)?.status, 'running');
    assert.equal(appointmentsDb.claim('appointment-1', 2_100), null);
    assert.equal(appointmentsDb.transition('appointment-1', 'scheduled', 'completed'), false);
    assert.equal(appointmentsDb.transition('appointment-1', 'running', 'completed', 2_200), true);
  });
});
test('draft queue activation for dispatch is scoped and conditional', async () => { await withDatabase(() => { createAppointment({ triggerType: 'queue', dueAt: null, isActive: false }); assert.equal(appointmentsDb.activateDraftForDispatch('appointment-1', 'project-1', 'user-2', 1_100), null); assert.equal(appointmentsDb.activateDraftForDispatch('appointment-1', 'project-1', 'user-1', 1_100)?.status, 'scheduled'); assert.equal(appointmentsDb.activateDraftForDispatch('appointment-1', 'project-1', 'user-1', 1_101), null); }); });

test('startup review marks only active scheduled project-idle rows', async () => {
  await withDatabase(() => {
    createAppointment({ id: 'idle-active', triggerType: 'project_idle', dueAt: null });
    createAppointment({ id: 'idle-draft', triggerType: 'project_idle', dueAt: null, isActive: false });
    createAppointment({ id: 'exact-active' });
    appointmentsDb.update('idle-active', 'project-1', 'user-1', { projectIdleSince: 900 });
    assert.equal(appointmentsDb.markActiveProjectIdleNeedsReview(3_000), 1);
    assert.equal(appointmentsDb.getById('idle-active', 'project-1', 'user-1')?.status, 'needs_review');
    assert.equal(appointmentsDb.getById('idle-active', 'project-1', 'user-1')?.projectIdleSince, null);
    assert.equal(appointmentsDb.getById('idle-draft', 'project-1', 'user-1')?.status, 'draft');
    assert.equal(appointmentsDb.getById('exact-active', 'project-1', 'user-1')?.status, 'scheduled');
  });
});
