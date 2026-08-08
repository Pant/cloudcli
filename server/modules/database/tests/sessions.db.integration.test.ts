import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
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

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

test('createSession reactivates archived rows when the session becomes active again', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const restoredSession = sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 1);
    assert.equal(activeSessions[0]?.session_id, 'session-reused');
    assert.equal(activeSessions[0]?.custom_name, 'Updated Name');
    assert.equal(archivedSessions.length, 0);
    assert.equal(restoredSession?.isArchived, 0);
  });
});

test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('fresh databases include nullable provider parent metadata', async () => {
  await withIsolatedDatabase(() => {
    const columns = getConnection().prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const parentColumn = columns.find((column) => column.name === 'provider_parent_session_id');
    assert.equal(parentColumn?.notnull, 0);

    const hierarchyMarker = getConnection()
      .prepare("SELECT value FROM app_config WHERE key = 'opencode_hierarchy_backfill_version'")
      .get() as { value: string } | undefined;
    assert.equal(hierarchyMarker?.value, '1');
  });
});

test('migrated databases add provider parent metadata and reset the scan cursor', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        project_path TEXT UNIQUE NOT NULL,
        custom_project_name TEXT,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      );
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'claude',
        provider_session_id TEXT,
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        model TEXT,
        agent TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME,
        updated_at DATETIME
      );
      CREATE TABLE scan_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_scanned_at TIMESTAMP NULL);
      INSERT INTO scan_state (id, last_scanned_at) VALUES (1, '2026-01-01 00:00:00');
    `);

    runMigrations(db);

    const parentColumn = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
      notnull: number;
    }>).find((column) => column.name === 'provider_parent_session_id');
    assert.equal(parentColumn?.notnull, 0);
    const scanState = db.prepare('SELECT last_scanned_at FROM scan_state WHERE id = 1').get() as {
      last_scanned_at: string | null;
    };
    assert.equal(scanState.last_scanned_at, null);

    const marker = db
      .prepare("SELECT value FROM app_config WHERE key = 'opencode_hierarchy_backfill_version'")
      .get() as { value: string } | undefined;
    assert.equal(marker?.value, '1');

    db.prepare('UPDATE scan_state SET last_scanned_at = ? WHERE id = 1').run('2026-02-01 00:00:00');
    runMigrations(db);

    const secondRunScanState = db.prepare('SELECT last_scanned_at FROM scan_state WHERE id = 1').get() as {
      last_scanned_at: string | null;
    };
    assert.equal(secondRunScanState.last_scanned_at, '2026-02-01 00:00:00');
    const secondRunMarker = db
      .prepare("SELECT value FROM app_config WHERE key = 'opencode_hierarchy_backfill_version'")
      .get() as { value: string } | undefined;
    assert.equal(secondRunMarker?.value, '1');
  } finally {
    db.close();
  }
});

test('partial hierarchy upgrades reset the scan cursor once even when the parent column already exists', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
      CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        project_path TEXT UNIQUE NOT NULL,
        custom_project_name TEXT,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      );
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'claude',
        provider_session_id TEXT,
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        model TEXT,
        agent TEXT,
        provider_parent_session_id TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME,
        updated_at DATETIME
      );
      CREATE TABLE scan_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_scanned_at TIMESTAMP NULL);
      INSERT INTO scan_state (id, last_scanned_at) VALUES (1, '2026-01-01 00:00:00');
    `);

    runMigrations(db);

    const firstRunScanState = db.prepare('SELECT last_scanned_at FROM scan_state WHERE id = 1').get() as {
      last_scanned_at: string | null;
    };
    assert.equal(firstRunScanState.last_scanned_at, null);
    assert.equal(
      (db.prepare("SELECT value FROM app_config WHERE key = 'opencode_hierarchy_backfill_version'").get() as { value: string }).value,
      '1',
    );

    db.prepare('UPDATE scan_state SET last_scanned_at = ? WHERE id = 1').run('2026-02-01 00:00:00');
    runMigrations(db);

    const secondRunScanState = db.prepare('SELECT last_scanned_at FROM scan_state WHERE id = 1').get() as {
      last_scanned_at: string | null;
    };
    assert.equal(secondRunScanState.last_scanned_at, '2026-02-01 00:00:00');
    assert.equal(
      (db.prepare("SELECT value FROM app_config WHERE key = 'opencode_hierarchy_backfill_version'").get() as { value: string }).value,
      '1',
    );
  } finally {
    db.close();
  }
});
