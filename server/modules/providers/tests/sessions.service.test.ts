import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionRunStateDb, sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, reconcileInterruptedOpenCodeRuns } from '@/modules/websocket/index.js';

class FakeConnection {
  readyState = 1;

  send(): void {}
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-db-'));

  closeConnection();
  chatRunRegistry.clearAll();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
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

async function withOpenCodeHome(runTest: (homeDir: string) => void | Promise<void>): Promise<void> {
  const previousHome = os.homedir;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-opencode-'));
  (os as any).homedir = () => tempDirectory;

  try {
    await runTest(tempDirectory);
  } finally {
    (os as any).homedir = previousHome;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function seedOpenCodeActivityDatabase(homeDir: string, parts: unknown[]): void {
  const dataDirectory = path.join(homeDir, '.local', 'share', 'opencode');
  mkdirSync(dataDirectory, { recursive: true });
  const db = new Database(path.join(dataDirectory, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      )
    `);
    const insert = db.prepare('INSERT INTO part (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
    parts.forEach((part, index) => {
      insert.run(`part-${index}`, 'root-native', 1_700_000_000_000 + index, JSON.stringify(part));
    });
  } finally {
    db.close();
  }
}

test('provider session id returns the mapped native id', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-id', 'codex', '/tmp/session-id-copy-project');
    sessionsDb.assignProviderSessionId('app-session-id', 'codex-native-session-id');

    assert.equal(sessionsService.getProviderSessionId('app-session-id'), 'codex-native-session-id');
  });
});

test('provider session id is unavailable until the provider assigns one', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('pending-app-session', 'claude', '/tmp/session-id-copy-project');

    assert.throws(
      () => sessionsService.getProviderSessionId('pending-app-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'PROVIDER_SESSION_ID_NOT_AVAILABLE' && typedError.statusCode === 409;
      },
    );
  });
});

test('provider session id reports a missing app session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getProviderSessionId('missing-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_NOT_FOUND' && typedError.statusCode === 404;
      },
    );
  });
});

test('session cache manifest includes active, archived, and history-not-ready rows once', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'provider-active',
      'claude',
      '/workspace/manifest-project',
      'Active session',
      '2025-01-01T00:00:00.000Z',
      '2025-01-02T00:00:00.000Z',
      '/not-read/active.jsonl',
    );
    sessionsDb.createSession(
      'provider-archived',
      'codex',
      '/workspace/manifest-project',
      'Archived session',
      '2025-01-03T00:00:00.000Z',
      '2025-01-04T00:00:00.000Z',
      '/not-read/archived.jsonl',
    );
    sessionsDb.updateSessionIsArchived('provider-archived', true);
    sessionsDb.createAppSession('app-pending', 'opencode', '/workspace/manifest-project');

    const firstManifest = sessionsService.listSessionCacheManifest();
    const secondManifest = sessionsService.listSessionCacheManifest();

    assert.deepEqual(firstManifest, secondManifest);
    assert.deepEqual(
      firstManifest.map((session) => session.sessionId).sort(),
      ['app-pending', 'provider-active', 'provider-archived'],
    );

    assert.deepEqual(firstManifest.find((session) => session.sessionId === 'provider-active'), {
      sessionId: 'provider-active',
      provider: 'claude',
      revision: '2025-01-02T00:00:00.000Z',
      isArchived: false,
      historyReady: true,
    });
    assert.deepEqual(firstManifest.find((session) => session.sessionId === 'provider-archived'), {
      sessionId: 'provider-archived',
      provider: 'codex',
      revision: '2025-01-04T00:00:00.000Z',
      isArchived: true,
      historyReady: true,
    });

    const pending = firstManifest.find((session) => session.sessionId === 'app-pending');
    assert.ok(pending);
    assert.equal(pending.provider, 'opencode');
    assert.equal(pending.isArchived, false);
    assert.equal(pending.historyReady, false);
    assert.match(pending.revision, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('listRunningSessions unions canonical OpenCode native children and prefers registry metadata', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    await withOpenCodeHome((homeDir) => {
      const projectPath = '/workspace/nested-running';
      sessionsDb.createAppSession('root-app', 'opencode', projectPath);
      sessionsDb.assignProviderSessionId('root-app', 'root-native');
      sessionsDb.createSession('child-native', 'opencode', projectPath, 'Child', undefined, undefined, null, null, 'root-native');
      sessionsDb.createSession('grandchild-native', 'opencode', projectPath, 'Grandchild', undefined, undefined, null, null, 'child-native');
      sessionsDb.createSession('unknown-parent-native', 'opencode', projectPath, 'Unknown', undefined, undefined, null, null, 'root-native');

      seedOpenCodeActivityDatabase(homeDir, [
        {
          type: 'tool',
          tool: 'task',
          state: { status: 'running', metadata: { sessionId: 'child-native' } },
        },
        {
          type: 'tool',
          tool: 'task',
          state: { status: 'running', metadata: { childSessionId: 'grandchild-native' } },
        },
        {
          type: 'tool',
          tool: 'task',
          state: { status: 'running', metadata: { sessionId: 'not-indexed' } },
        },
        {
          type: 'tool',
          tool: 'task',
          state: { status: 'completed', metadata: { sessionId: 'unknown-parent-native' } },
        },
      ]);

      const connection = new FakeConnection();
      const run = chatRunRegistry.startRun({
        appSessionId: 'root-app',
        provider: 'opencode',
        providerSessionId: 'root-native',
        connection,
        userId: null,
      });
      assert.ok(run);

      const sessions = sessionsService.listRunningSessions();
      assert.deepEqual(sessions.map((session) => session.sessionId), ['root-app', 'child-native', 'grandchild-native']);
      assert.equal(sessions[0]?.startedAt, run.startedAt);
      assert.equal(sessions[0]?.canInterrupt, true);
      assert.equal(sessions[1]?.canInterrupt, false);
      assert.equal(sessions[2]?.canInterrupt, false);
      assert.equal(sessions[1]?.parentSessionId, 'root-app');
      assert.equal(sessions[2]?.parentSessionId, 'child-native');
       assert.equal(sessions[1]?.project?.path, projectPath);
       assert.equal(sessions[2]?.session?.id, 'grandchild-native');
       assert.deepEqual(sessions[2]?.ancestors, undefined);
     });
   });
});

test('listRunningSessions hydrates deduplicated inactive canonical ancestor context', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    await withOpenCodeHome((homeDir) => {
      const projectPath = '/workspace/ancestor-context';
      sessionsDb.createAppSession('root-app', 'opencode', projectPath);
      sessionsDb.assignProviderSessionId('root-app', 'root-native');
      sessionsDb.createAppSession('parent-app', 'opencode', projectPath);
      sessionsDb.assignProviderSessionId('parent-app', 'parent-native');
      sessionsDb.createSession('parent-native', 'opencode', projectPath, 'Parent', undefined, undefined, null, null, 'root-native');
      sessionsDb.createAppSession('grandchild-app', 'opencode', projectPath);
      sessionsDb.assignProviderSessionId('grandchild-app', 'grandchild-native');
      sessionsDb.createSession('grandchild-native', 'opencode', projectPath, 'Grandchild', undefined, undefined, null, null, 'parent-native');
      sessionsDb.createAppSession('sibling-grandchild-app', 'opencode', projectPath);
      sessionsDb.assignProviderSessionId('sibling-grandchild-app', 'sibling-grandchild-native');
      sessionsDb.createSession('sibling-grandchild-native', 'opencode', projectPath, 'Sibling', undefined, undefined, null, null, 'parent-native');

      seedOpenCodeActivityDatabase(homeDir, [
        {
          type: 'tool',
          tool: 'task',
          state: { status: 'running', metadata: { childSessionId: 'grandchild-native' } },
        },
        {
          type: 'tool',
          tool: 'task',
          state: { status: 'running', metadata: { childSessionId: 'sibling-grandchild-native' } },
        },
      ]);

      const run = chatRunRegistry.startRun({
        appSessionId: 'root-app',
        provider: 'opencode',
        providerSessionId: 'root-native',
        connection: new FakeConnection(),
        userId: null,
      });
      assert.ok(run);

      const sessions = sessionsService.listRunningSessions();
      assert.deepEqual(sessions.map((session) => session.sessionId), [
        'root-app',
        'grandchild-app',
        'sibling-grandchild-app',
      ]);
      assert.deepEqual(sessions[1]?.ancestors?.map((ancestor) => ancestor.sessionId), ['parent-app']);
      assert.equal(sessions[2]?.ancestors, undefined);
      assert.equal(JSON.stringify(sessions).includes('root-native'), false);
      assert.equal(JSON.stringify(sessions).includes('parent-native'), false);
      assert.equal(sessions.filter((session) => session.status === 'running').length, 3);
      assert.equal(sessions.filter((session) => session.canInterrupt).length, 1);
    });
  });
});

test('listRunningSessions fails open for missing and cyclic ancestor relationships', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    await withOpenCodeHome((homeDir) => {
      const projectPath = '/workspace/ancestor-fail-open';
      sessionsDb.createAppSession('root-app', 'opencode', projectPath);
      sessionsDb.assignProviderSessionId('root-app', 'root-native');
      sessionsDb.createSession('cyclic-a-native', 'opencode', projectPath, 'A', undefined, undefined, null, null, 'cyclic-b-native');
      sessionsDb.createSession('cyclic-b-native', 'opencode', projectPath, 'B', undefined, undefined, null, null, 'cyclic-a-native');
      sessionsDb.createSession('missing-child-native', 'opencode', projectPath, 'Missing', undefined, undefined, null, null, 'missing-parent-native');

      seedOpenCodeActivityDatabase(homeDir, [
        {
          type: 'tool',
          tool: 'task',
          state: { status: 'running', metadata: { childSessionId: 'cyclic-a-native' } },
        },
        {
          type: 'tool',
          tool: 'task',
          state: { status: 'running', metadata: { childSessionId: 'missing-child-native' } },
        },
      ]);

      const run = chatRunRegistry.startRun({
        appSessionId: 'root-app',
        provider: 'opencode',
        providerSessionId: 'root-native',
        connection: new FakeConnection(),
        userId: null,
      });
      assert.ok(run);

      const sessions = sessionsService.listRunningSessions();
      assert.deepEqual(sessions.map((session) => session.sessionId), ['root-app']);
      assert.equal(JSON.stringify(sessions).includes('missing-parent-native'), false);
      assert.equal(JSON.stringify(sessions).includes('cyclic-a-native'), false);
    });
  });
});

test('listRunningSessions leaves non-OpenCode registry runs unchanged and fails open for malformed provider data', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('claude-running', 'claude', '/workspace/claude');
    const run = chatRunRegistry.startRun({
      appSessionId: 'claude-running',
      provider: 'claude',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: null,
    });
    assert.ok(run);

    const sessions = sessionsService.listRunningSessions();
    assert.deepEqual(sessions.map((session) => session.sessionId), ['claude-running']);
    assert.equal(sessions[0]?.provider, 'claude');
    assert.equal(sessions[0]?.canInterrupt, true);
    assert.equal(sessions[0]?.parentSessionId, null);
  });
});

test('listRunningSessions omits unknown parent state for registry-only rows', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const run = chatRunRegistry.startRun({
      appSessionId: 'registry-only-session',
      provider: 'claude',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: null,
    });
    assert.ok(run);

    const sessions = sessionsService.listRunningSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.session, null);
    assert.equal('parentSessionId' in (sessions[0] ?? {}), false);
  });
});

test('listRunningSessions omits unresolved parent metadata without leaking native ids', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('running-child-app', 'opencode', '/workspace/running-unresolved');
    sessionsDb.createSession(
      'running-child-native',
      'opencode',
      '/workspace/running-unresolved',
      'Running child',
      undefined,
      undefined,
      null,
      null,
      'missing-running-parent-native',
    );
    sessionsDb.assignProviderSessionId('running-child-app', 'running-child-native');

    const run = chatRunRegistry.startRun({
      appSessionId: 'running-child-app',
      provider: 'opencode',
      providerSessionId: 'running-child-native',
      connection: new FakeConnection(),
      userId: null,
    });
    assert.ok(run);

    const running = sessionsService.listRunningSessions();
    assert.equal(running.length, 1);
    assert.equal('parentSessionId' in (running[0] ?? {}), false);
    assert.equal(JSON.stringify(running).includes('missing-running-parent-native'), false);
  });
});

test('listSessionLifecycleStatus preserves durable manual-stop precedence and canonical ancestry', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    await withOpenCodeHome((homeDir) => {
      const projectPath = '/workspace/lifecycle';
      sessionsDb.createAppSession('root-app', 'opencode', projectPath);
      sessionsDb.assignProviderSessionId('root-app', 'root-native');
      sessionsDb.createAppSession('child-app', 'opencode', projectPath);
      sessionsDb.assignProviderSessionId('child-app', 'child-native');
      sessionsDb.createSession('child-native', 'opencode', projectPath, 'Child', undefined, undefined, null, null, 'root-native');
      seedOpenCodeActivityDatabase(homeDir, [{
        type: 'tool', tool: 'task', state: { status: 'running', metadata: { sessionId: 'child-native' } },
      }]);
      const state = sessionRunStateDb.beginRun({ sessionId: 'child-app', provider: 'opencode', now: 100 });
      sessionRunStateDb.requestManualStop('child-app', state.generation, 200);

      const status = sessionsService.listSessionLifecycleStatus(1_800_000_000_000);
      assert.equal(status.length, 1);
      assert.equal(status[0]?.sessionId, 'child-app');
      assert.equal(status[0]?.status, 'manually_stopped');
      assert.equal(status[0]?.restartable, true);
      assert.equal(status[0]?.canInterrupt, false);
      assert.deepEqual(status[0]?.ancestors?.map((ancestor) => ancestor.sessionId), ['root-app']);
      assert.equal(JSON.stringify(status).includes('child-native'), false);
      assert.equal(JSON.stringify(status).includes('root-native'), false);
    });
  });
});

test('listSessionLifecycleStatus exposes startup-interrupted and terminal outcomes as restartable', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    for (const id of ['interrupted', 'failed', 'exited']) sessionsDb.createAppSession(id, 'opencode', '/workspace/restart-status');
    sessionRunStateDb.beginRun({ sessionId: 'interrupted', provider: 'opencode', now: 10 });
    const failed = sessionRunStateDb.beginRun({ sessionId: 'failed', provider: 'opencode', now: 10 });
    sessionRunStateDb.recordTerminal('failed', failed.generation, { lifecycleState: 'failed', terminalReason: 'provider_error', now: 20 });
    const exited = sessionRunStateDb.beginRun({ sessionId: 'exited', provider: 'opencode', now: 10 });
    sessionRunStateDb.recordTerminal('exited', exited.generation, { lifecycleState: 'exited', terminalReason: 'process_exited', now: 20 });
    const originals = { health: providerRuntimeService.getHealth, children: providerRuntimeService.listChildActivity, approvals: providerRuntimeService.getPendingApprovalsForSession };
    providerRuntimeService.getHealth = () => ({ state: 'missing', startedAt: null, lastOutputAt: null, exitCode: null });
    providerRuntimeService.listChildActivity = () => [];
    providerRuntimeService.getPendingApprovalsForSession = () => [];
    try { reconcileInterruptedOpenCodeRuns({ now: () => 30 }); } finally {
      providerRuntimeService.getHealth = originals.health;
      providerRuntimeService.listChildActivity = originals.children;
      providerRuntimeService.getPendingApprovalsForSession = originals.approvals;
    }
    const status = new Map(sessionsService.listSessionLifecycleStatus(40).map((entry) => [entry.sessionId, entry]));
    assert.equal(status.get('interrupted')?.status, 'stalled');
    assert.equal(status.get('interrupted')?.restartable, true);
    assert.match(status.get('interrupted')?.statusText ?? '', /Restart/);
    assert.equal(status.get('failed')?.status, 'failed');
    assert.equal(status.get('exited')?.status, 'exited');
  });
});

test('listSessionLifecycleStatus classifies fresh, stale viable, absent-owner, terminal and completed children', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    await withOpenCodeHome((homeDir) => {
      const now = 1_800_000_000_000;
      const projectPath = '/workspace/lifecycle-children';
      sessionsDb.createAppSession('root-app', 'opencode', projectPath);
      sessionsDb.assignProviderSessionId('root-app', 'root-native');
      for (const id of ['fresh', 'stale', 'orphan', 'error', 'done']) {
        sessionsDb.createSession(`${id}-native`, 'opencode', projectPath, id, undefined, undefined, null, null, id === 'orphan' ? 'missing-native' : 'root-native');
      }
      seedOpenCodeActivityDatabase(homeDir, [
        { type: 'tool', tool: 'task', state: { status: 'running', metadata: { sessionId: 'fresh-native' } } },
        { type: 'tool', tool: 'task', state: { status: 'running', metadata: { sessionId: 'stale-native' } } },
        { type: 'tool', tool: 'task', state: { status: 'running', metadata: { sessionId: 'orphan-native' } } },
        { type: 'tool', tool: 'task', state: { status: 'error', metadata: { sessionId: 'error-native' } } },
        { type: 'tool', tool: 'task', state: { status: 'completed', metadata: { sessionId: 'done-native' } } },
      ]);
      sessionRunStateDb.beginRun({ sessionId: 'root-app', provider: 'opencode', now: now - 1_000 });
      const run = chatRunRegistry.startRun({ appSessionId: 'root-app', provider: 'opencode', providerSessionId: 'root-native', connection: new FakeConnection(), userId: null });
      assert.ok(run);
      const status = sessionsService.listSessionLifecycleStatus(now);
      const byId = new Map(status.map((entry) => [entry.sessionId, entry.status]));
      assert.equal(byId.get('root-app'), 'running');
      assert.equal(byId.get('fresh-native'), 'stalled');
      assert.equal(byId.get('stale-native'), 'stalled');
      assert.equal(byId.get('orphan-native'), 'exited');
      assert.equal(byId.get('error-native'), 'failed');
      assert.equal(byId.has('done-native'), false);
    });
  });
});
