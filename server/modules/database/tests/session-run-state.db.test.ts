import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionRunStateDb } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'session-run-state-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  sessionsDb.createAppSession('session-1', 'opencode', '/workspace/project');
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

test('fresh and upgraded databases contain the lifecycle schema idempotently', async () => {
  await withDatabase(() => {
    const table = getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_run_state'").get();
    const indexes = getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_run_state'").all() as Array<{ name: string }>;
    assert.ok(table);
    assert.ok(getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_run_history'").get());
    assert.deepEqual((getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_run_history'").all() as Array<{ name: string }>).map(({ name }) => name).filter((name) => name.startsWith('idx_')).sort(), ['idx_session_run_history_recent', 'idx_session_run_history_session_recent']);
    assert.deepEqual(indexes.map(({ name }) => name).filter((name) => name.startsWith('idx_')).sort(), ['idx_session_run_state_actionable', 'idx_session_run_state_recovery']);
  });

  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT)');
    runMigrations(db);
    runMigrations(db);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_run_state'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_run_history'").get());
  } finally {
    db.close();
  }
});

test('history is immutable, generation-fenced, sanitized, ordered, and independent of current state', async () => {
  await withDatabase(() => {
    const first = sessionRunStateDb.beginRun({ sessionId: 'session-1', provider: 'opencode', now: 100 });
    const oversized = '🙂'.repeat(20_000);
    assert.equal(sessionRunStateDb.appendHistory({ sessionId: 'session-1', generation: first.generation, provider: 'opencode', startedAt: 100, terminalAt: 150, lifecycleState: 'exited', terminalReason: 'process_exited', terminalMessage: oversized, exitCode: 9, signal: 'SIGKILL', diagnostic: { runId: 'run-1', relativePath: '../escape' }, stderrTail: oversized, resources: { start: { scope: 'container-cgroup-v2', capturedAt: 101, memoryCurrentBytes: 123, memoryEvents: { oom_kill: 1, '../bad': 2 }, secret: 'no' }, end: { scope: 'wrong', capturedAt: 150 } } }), true);
    assert.equal(sessionRunStateDb.appendHistory({ sessionId: 'session-1', generation: first.generation, provider: 'opencode', startedAt: 999, terminalAt: 999, lifecycleState: 'completed', terminalReason: 'completed' }), false);

    const second = sessionRunStateDb.beginRun({ sessionId: 'session-1', provider: 'opencode', now: 200 });
    assert.equal(sessionRunStateDb.appendHistory({ sessionId: 'session-1', generation: first.generation, provider: 'opencode', startedAt: 100, terminalAt: 250, lifecycleState: 'failed', terminalReason: 'provider_error' }), false);
    assert.equal(sessionRunStateDb.appendHistory({ sessionId: 'session-1', generation: second.generation, provider: 'opencode', startedAt: 200, terminalAt: 250, lifecycleState: 'completed', terminalReason: 'completed', exitCode: 0, signal: 'NOT_A_SIGNAL', diagnostic: { runId: 'run-2', relativePath: 'run-2' }, resources: '{bad json' }), true);

    const history = sessionRunStateDb.listRecentHistory(10, 'session-1');
    assert.deepEqual(history.map(({ generation }) => generation), [2, 1]);
    assert.equal(history[0]?.diagnostic?.relativePath, 'run-2');
    assert.equal(history[0]?.signal, null);
    assert.equal(history[0]?.resources, null);
    assert.equal(history[1]?.diagnostic, null);
    assert.equal(history[1]?.terminalMessage?.length, 2_000);
    assert.ok(Buffer.byteLength(history[1]?.stderrTail ?? '', 'utf8') <= 64_000);
    assert.deepEqual(history[1]?.resources, { start: { scope: 'container-cgroup-v2', capturedAt: 101, memoryCurrentBytes: 123, memoryEvents: { oom_kill: 1 } } });
    assert.equal(sessionRunStateDb.getById('session-1')?.generation, 2);
  });
});

test('pruning removes only oldest non-current history rows', async () => {
  await withDatabase(() => {
    for (let generation = 1; generation <= 4; generation += 1) {
      const run = sessionRunStateDb.beginRun({ sessionId: 'session-1', provider: 'opencode', now: generation * 100 });
      assert.equal(run.generation, generation);
      assert.equal(sessionRunStateDb.appendHistory({ sessionId: 'session-1', generation, provider: 'opencode', startedAt: generation * 100, terminalAt: generation * 100 + 10, lifecycleState: 'completed', terminalReason: 'completed', exitCode: 0 }), true);
    }
    assert.equal(sessionRunStateDb.pruneHistory(1), 2);
    assert.deepEqual(sessionRunStateDb.listRecentHistory(10).map(({ generation }) => generation), [4, 3]);
    assert.equal(sessionRunStateDb.getById('session-1')?.generation, 4);
  });
});

test('generations fence stale progress and terminal writes while sanitizing continuation options', async () => {
  await withDatabase(() => {
    const first = sessionRunStateDb.beginRun({
      sessionId: 'session-1', provider: 'opencode', now: 100,
      continuationOptions: { model: 'safe-model', effort: 'high', agent: 'build', permissionMode: 'ask', projectPath: '/workspace/project', cwd: '/workspace/project', attachments: ['secret'], providerSessionId: 'native-id', images: ['secret'] },
    });
    const second = sessionRunStateDb.beginRun({ sessionId: 'session-1', provider: 'opencode', now: 200, continuationOptions: first.continuationOptions });
    assert.equal(second.generation, 2);
    assert.equal(second.desiredState, 'running');
    assert.deepEqual(second.continuationOptions, { model: 'safe-model', effort: 'high', agent: 'build', permissionMode: 'ask', projectPath: '/workspace/project', cwd: '/workspace/project' });
    assert.equal(sessionRunStateDb.recordProgress('session-1', 1, 300), false);
    assert.equal(sessionRunStateDb.recordTerminal('session-1', 1, { lifecycleState: 'completed', terminalReason: 'completed', now: 300 }), false);
    assert.equal(sessionRunStateDb.getById('session-1')?.lastProgressAt, 200);
  });
});

test('manual stop wins over terminal callbacks and only an explicit begin restarts it', async () => {
  await withDatabase(() => {
    const run = sessionRunStateDb.beginRun({ sessionId: 'session-1', provider: 'opencode', now: 10 });
    assert.equal(sessionRunStateDb.requestManualStop('session-1', run.generation, 20), true);
    assert.equal(sessionRunStateDb.recordTerminal('session-1', run.generation, { lifecycleState: 'failed', terminalReason: 'provider_error', terminalMessage: 'late', now: 30 }), false);
    assert.equal(sessionRunStateDb.claimRecovery('session-1', run.generation, 3, 40), null);
    assert.equal(sessionRunStateDb.getById('session-1')?.lifecycleState, 'manually_stopped');
    const restarted = sessionRunStateDb.beginRun({ sessionId: 'session-1', provider: 'opencode', now: 50 });
    assert.equal(restarted.generation, run.generation + 1);
    assert.equal(restarted.desiredState, 'running');
  });
});

test('terminal and recovery transitions retain metadata and bounded atomic claims', async () => {
  await withDatabase(() => {
    let run = sessionRunStateDb.beginRun({ sessionId: 'session-1', provider: 'opencode', now: 100 });
    assert.equal(sessionRunStateDb.markStalled('session-1', run.generation, 'no progress', 200, 150), true);
    assert.equal(sessionRunStateDb.claimRecovery('session-1', run.generation, 2, 199), null);
    const firstClaim = sessionRunStateDb.claimRecovery('session-1', run.generation, 2, 200);
    assert.equal(firstClaim?.lifecycleState, 'recovering');
    assert.equal(firstClaim?.restartCount, 1);
    assert.equal(sessionRunStateDb.claimRecovery('session-1', run.generation, 2, 200), null);

    run = firstClaim!;
    assert.equal(sessionRunStateDb.recordTerminal('session-1', run.generation, { lifecycleState: 'failed', terminalReason: 'provider_error', terminalMessage: 'auth failed', exitCode: 17, now: 250 }), true);
    assert.equal(sessionRunStateDb.markStalled('session-1', run.generation, 'retry later', 300, 260), true);
    const secondClaim = sessionRunStateDb.claimRecovery('session-1', run.generation, 2, 300);
    assert.equal(secondClaim?.restartCount, 2);
    assert.equal(sessionRunStateDb.recordTerminal('session-1', secondClaim!.generation, { lifecycleState: 'exited', terminalReason: 'process_exited', exitCode: 9, terminalMessage: 'gone', now: 350 }), true);
    assert.equal(sessionRunStateDb.claimRecovery('session-1', secondClaim!.generation, 2, 350), null);
    assert.equal(sessionRunStateDb.markRecoveryExhausted('session-1', secondClaim!.generation, 'retry limit reached', 360), true);
    const exhausted = sessionRunStateDb.getById('session-1');
    assert.equal(exhausted?.terminalMessage, 'retry limit reached');
    assert.equal(exhausted?.terminalReason, 'recovery_exhausted');
    assert.equal(sessionRunStateDb.listActionable().length, 1);
  });
});

test('successful completion clears desired-running intent', async () => {
  await withDatabase(() => {
    const run = sessionRunStateDb.beginRun({ sessionId: 'session-1', provider: 'opencode', now: 10 });
    assert.equal(sessionRunStateDb.recordTerminal('session-1', run.generation, { lifecycleState: 'completed', terminalReason: 'completed', now: 20 }), true);
    assert.equal(sessionRunStateDb.getById('session-1')?.desiredState, 'stopped');
    assert.deepEqual(sessionRunStateDb.listActionable(), []);
  });
});

test('startup interruption is generation-fenced, eligible-state-only, and idempotent', async () => {
  await withDatabase(() => {
    const first = sessionRunStateDb.beginRun({ sessionId: 'session-1', provider: 'opencode', now: 10 });
    const current = sessionRunStateDb.beginRun({ sessionId: 'session-1', provider: 'opencode', now: 20 });
    assert.deepEqual(sessionRunStateDb.listStartupReconciliationCandidates().map(({ generation }) => generation), [current.generation]);
    assert.equal(sessionRunStateDb.markStartupInterrupted('session-1', first.generation, 'restart required', 30), false);
    assert.equal(sessionRunStateDb.markStartupInterrupted('session-1', current.generation, 'restart required', 30), true);
    assert.equal(sessionRunStateDb.markStartupInterrupted('session-1', current.generation, 'changed', 40), false);
    const state = sessionRunStateDb.getById('session-1')!;
    assert.equal(state.lifecycleState, 'stalled');
    assert.equal(state.terminalMessage, 'restart required');
    assert.deepEqual(sessionRunStateDb.listStartupReconciliationCandidates(), []);
  });
});
