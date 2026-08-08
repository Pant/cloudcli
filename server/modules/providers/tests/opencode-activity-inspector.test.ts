import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  listOpenCodeChildActivitySnapshots,
  listOpenCodeRunningChildSessions,
} from '@/modules/providers/list/opencode/opencode-activity-inspector.provider.js';

async function withDatabase(
  parts: unknown[],
  runTest: (databasePath: string) => void | Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-activity-inspector-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const db = new Database(databasePath);

  try {
    db.exec(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      )
    `);
    const insert = db.prepare('INSERT INTO part (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
    parts.forEach((part, index) => {
      insert.run(`part-${index}`, 'parent-native', 1_700_000_000_000 + index, 1_700_000_000_000 + index, typeof part === 'string' ? part : JSON.stringify(part));
    });
  } finally {
    db.close();
  }

  try {
    await runTest(databasePath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('inspector returns active current Task child sessions and preserves timing/status', async () => {
  await withDatabase([
    {
      type: 'tool',
      tool: 'task',
      state: {
        status: 'running',
        time: { start: 1_700_000_000_123 },
        metadata: {
          parentSessionId: 'parent-native',
          sessionId: 'child-native',
          title: 'Inspect repository',
        },
      },
    },
    {
      type: 'tool',
      tool: 'task',
      state: {
        status: 'pending',
        input: { sessionID: 'pending-child-native' },
      },
    },
  ], (databasePath) => {
    assert.deepEqual(listOpenCodeRunningChildSessions(databasePath), [
      {
        providerSessionId: 'child-native',
        startedAt: 1_700_000_000_123,
        statusText: 'Inspect repository',
      },
      {
        providerSessionId: 'pending-child-native',
        startedAt: 1_700_000_000_001,
        statusText: null,
      },
    ]);
  });
});

test('inspector supports nested children and known legacy JSON field variants', async () => {
  await withDatabase([
    {
      type: 'tool_use',
      name: 'subagent',
      toolState: {
        status: 'running',
        metadata: { child_session_id: 'legacy-child', started_at: '2025-01-01T00:00:00.000Z' },
      },
    },
    {
      type: 'tool',
      tool: 'task',
      state: {
        status: 'running',
        metadata: { nested: { taskSessionId: 'nested-child' } },
      },
    },
  ], (databasePath) => {
    assert.deepEqual(
      listOpenCodeRunningChildSessions(databasePath).map((entry) => entry.providerSessionId),
      ['legacy-child', 'nested-child'],
    );
  });
});

test('completed and error Task parts are not active', async () => {
  await withDatabase([
    { type: 'tool', tool: 'task', state: { status: 'completed', metadata: { sessionId: 'completed-child' } } },
    { type: 'tool', tool: 'task', state: { status: 'error', metadata: { sessionId: 'error-child' } } },
    { type: 'tool', tool: 'task', state: { status: 'running', metadata: { sessionId: 'active-child' } } },
  ], (databasePath) => {
    assert.deepEqual(
      listOpenCodeRunningChildSessions(databasePath).map((entry) => entry.providerSessionId),
      ['active-child'],
    );
  });
});

test('malformed Task JSON does not hide valid active parts', async () => {
  await withDatabase([
    '{not-json',
    { type: 'tool', tool: 'task', state: { status: 'running', metadata: { sessionId: 'valid-child' } } },
  ], (databasePath) => {
    assert.deepEqual(
      listOpenCodeRunningChildSessions(databasePath).map((entry) => entry.providerSessionId),
      ['valid-child'],
    );
  });
});

test('a later terminal update removes an earlier active child from the snapshot', async () => {
  await withDatabase([
    { type: 'tool', tool: 'task', state: { status: 'running', metadata: { sessionId: 'finished-child' } } },
    { type: 'tool', tool: 'task', state: { status: 'completed', metadata: { sessionId: 'finished-child' } } },
  ], (databasePath) => {
    assert.deepEqual(listOpenCodeRunningChildSessions(databasePath), []);
  });
});

test('lifecycle snapshots retain the latest terminal state and task update freshness', async () => {
  await withDatabase([
    { type: 'tool', tool: 'task', state: { status: 'running', metadata: { sessionId: 'finished-child' } } },
    { type: 'tool', tool: 'task', state: { status: 'cancelled', metadata: { sessionId: 'finished-child' } } },
    { type: 'tool', tool: 'task', state: { status: 'error', metadata: { sessionId: 'error-child' } } },
  ], (databasePath) => {
    const snapshots = listOpenCodeChildActivitySnapshots(databasePath);
    assert.deepEqual(snapshots.map(({ providerSessionId, state }) => ({ providerSessionId, state })), [
      { providerSessionId: 'finished-child', state: 'cancelled' },
      { providerSessionId: 'error-child', state: 'error' },
    ]);
    assert.equal(snapshots[0].taskUpdatedAt, 1_700_000_000_001);
    assert.equal(snapshots[0].lastActivityAt, 1_700_000_000_001);
  });
});

test('missing and malformed OpenCode databases fail open', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-activity-malformed-'));
  const malformedPath = path.join(tempDirectory, 'malformed.db');
  await mkdir(tempDirectory, { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(malformedPath, 'not sqlite'));

  try {
    assert.deepEqual(listOpenCodeRunningChildSessions(path.join(tempDirectory, 'missing.db')), []);
    assert.deepEqual(listOpenCodeRunningChildSessions(malformedPath), []);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('old databases without the part data column fail open', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-activity-old-schema-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const db = new Database(databasePath);
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY)');
  db.close();

  try {
    assert.deepEqual(listOpenCodeRunningChildSessions(databasePath), []);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
