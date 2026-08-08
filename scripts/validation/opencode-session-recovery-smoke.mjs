import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-reconciliation-smoke-'));
const databasePath = path.join(root, 'cloudcli.db');
const workspaceRoot = path.join(root, 'workspace-root');
const now = 2_000_000_000_000;

async function readJavaScriptTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return readJavaScriptTree(entryPath);
    return entry.name.endsWith('.js') ? readFile(entryPath, 'utf8') : '';
  }));
  return contents.join('\n');
}

let database;
let providers;
let websocket;
try {
  process.env.DATABASE_PATH = databasePath;
  process.env.WORKSPACES_ROOT = workspaceRoot;
  await mkdir(workspaceRoot, { recursive: true });

  const shared = await import('../../dist-server/server/shared/utils.js');
  database = await import('../../dist-server/server/modules/database/index.js');
  providers = await import('../../dist-server/server/modules/providers/index.js');
  websocket = await import('../../dist-server/server/modules/websocket/index.js');
  const { createAppointmentScheduler } = await import('../../dist-server/server/modules/appointments/appointment-scheduler.service.js');
  await database.initializeDatabase();

  assert.equal((await shared.validateWorkspacePath('/tmp')).valid, true);
  assert.equal((await shared.validateWorkspacePath(path.join('/tmp', 'cloudcli-built-smoke', 'child'))).valid, true);
  assert.equal((await shared.validateWorkspacePath('/home')).valid, false);

  for (const id of ['orphan-running', 'orphan-recovering', 'manual', 'failed', 'completed']) {
    database.sessionsDb.createAppSession(id, 'opencode', path.join('/tmp', id));
  }
  database.sessionRunStateDb.beginRun({ sessionId: 'orphan-running', provider: 'opencode', now: now - 10_000 });
  const recovering = database.sessionRunStateDb.beginRun({ sessionId: 'orphan-recovering', provider: 'opencode', now: now - 10_000 });
  {
    const rawDatabase = new Database(databasePath);
    rawDatabase.prepare("UPDATE session_run_state SET lifecycle_state = 'recovering' WHERE session_id = ? AND generation = ?").run('orphan-recovering', recovering.generation);
    rawDatabase.close();
  }
  const manual = database.sessionRunStateDb.beginRun({ sessionId: 'manual', provider: 'opencode', now: now - 10_000 });
  database.sessionRunStateDb.requestManualStop('manual', manual.generation, now - 9_000);
  for (const [id, lifecycleState] of [['failed', 'failed'], ['completed', 'completed']]) {
    const state = database.sessionRunStateDb.beginRun({ sessionId: id, provider: 'opencode', now: now - 10_000 });
    database.sessionRunStateDb.recordTerminal(id, state.generation, { lifecycleState, terminalReason: lifecycleState, now: now - 9_000 });
  }

  const calls = { run: 0, abort: 0 };
  const originalRun = providers.providerRuntimeService.run;
  const originalAbort = providers.providerRuntimeService.abort;
  const originalHealth = providers.providerRuntimeService.getHealth;
  const originalChildren = providers.providerRuntimeService.listChildActivity;
  const originalApprovals = providers.providerRuntimeService.getPendingApprovalsForSession;
  providers.providerRuntimeService.run = async (_provider, command) => {
    calls.run += 1;
    assert.equal(command, 'Continue');
    return new Promise(() => {});
  };
  providers.providerRuntimeService.abort = async () => { calls.abort += 1; return false; };
  providers.providerRuntimeService.getHealth = () => ({ state: 'missing', startedAt: null, lastOutputAt: null, exitCode: null });
  providers.providerRuntimeService.listChildActivity = () => [];
  providers.providerRuntimeService.getPendingApprovalsForSession = () => [];
  try {
    assert.equal(websocket.reconcileInterruptedOpenCodeRuns({ now: () => now }), 2);
    assert.deepEqual(calls, { run: 0, abort: 0 });
    for (const id of ['orphan-running', 'orphan-recovering']) {
      const state = database.sessionRunStateDb.getById(id);
      assert.equal(state.lifecycleState, 'stalled');
      assert.equal(state.desiredState, 'running');
      assert.match(state.terminalMessage, /Restart/);
    }
    assert.equal(database.sessionRunStateDb.getById('manual').lifecycleState, 'manually_stopped');
    assert.equal(database.sessionRunStateDb.getById('failed').lifecycleState, 'failed');
    assert.equal(database.sessionRunStateDb.getById('completed').lifecycleState, 'completed');
    assert.equal(websocket.reconcileInterruptedOpenCodeRuns({ now: () => now + 1 }), 0);

    const appointments = [{ id: 'queued', projectId: 'project', sessionId: 'failed', userId: 'user', provider: 'opencode', prompt: 'next', options: {}, attachments: [], triggerType: 'queue', dueAt: null, timerDurationMs: null, projectIdleSince: null, queuePosition: 1, runGeneration: null, isActive: true, status: 'scheduled', errorMessage: null, createdAt: 0, updatedAt: 0, claimedAt: null, completedAt: null }];
    const schedulerStarts = [];
    const appointmentStore = {
      listDue: () => [], listProjectIdle: () => [], listNextQueued: () => appointments.filter((row) => row.status === 'scheduled'), listRunning: () => appointments.filter((row) => row.status === 'running'), markActiveProjectIdleNeedsReview: () => 0,
      claim: (id) => { const row = appointments.find((item) => item.id === id && item.status === 'scheduled'); if (!row) return null; row.status = 'running'; return row; },
      activateDraftForDispatch: () => null, transition: () => false, update: () => null,
      assignRunGeneration: (id, generation) => { const row = appointments.find((item) => item.id === id); if (!row) return false; row.runGeneration = generation; return true; },
    };
    const scheduler = createAppointmentScheduler({ appointments: appointmentStore, getSessionById: () => ({ project_path: '/tmp/project' }), listRunningRuns: () => [], getRunState: (id) => database.sessionRunStateDb.getById(id), isProcessing: () => false, startRun: async (input) => { schedulerStarts.push(input); return { generation: 8 }; }, now: () => now, intervalMs: 10_000, idleQuiescenceMs: 1_000 });
    await scheduler.tick();
    assert.equal(schedulerStarts.length, 1);
    assert.equal(appointments[0].status, 'running');

    const priorGeneration = database.sessionRunStateDb.getById('manual').generation;
    await websocket.chatRunLifecycleService.manualStart('manual');
    assert.equal(calls.run, 1);
    assert.equal(database.sessionRunStateDb.getById('manual').generation, priorGeneration + 1);
  } finally {
    providers.providerRuntimeService.run = originalRun;
    providers.providerRuntimeService.abort = originalAbort;
    providers.providerRuntimeService.getHealth = originalHealth;
    providers.providerRuntimeService.listChildActivity = originalChildren;
    providers.providerRuntimeService.getPendingApprovalsForSession = originalApprovals;
  }

  const serverBuild = await readJavaScriptTree(path.resolve('dist-server/server'));
  assert.match(serverBuild, /\/tmp/);
  assert.match(serverBuild, /markStartupInterrupted/);
  assert.doesNotMatch(serverBuild, /setInterval\([^)]*reconcileInterruptedOpenCodeRuns/);
  assert.match(serverBuild, /listRunningRuns/);
  const clientBuild = await readJavaScriptTree(path.resolve('dist/assets'));
  assert.match(clientBuild, /session_upserted/);
  assert.match(clientBuild, /visibilitychange/);
  assert.match(clientBuild, /15e3/);
  assert.match(clientBuild, /1e3/);

  console.log(JSON.stringify({ temporaryWorkspace: true, reconciled: 2, automaticRuntimeCalls: 0, queuedAppointmentStarted: true, manualContinueGeneration: database.sessionRunStateDb.getById('manual').generation, adaptiveClientSync: true }));
} finally {
  websocket?.chatRunRegistry.clearAll();
  database?.closeConnection();
  delete process.env.DATABASE_PATH;
  delete process.env.WORKSPACES_ROOT;
  await rm(root, { recursive: true, force: true });
}
