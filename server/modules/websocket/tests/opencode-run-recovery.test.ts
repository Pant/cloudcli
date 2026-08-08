import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionRunStateDb, sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunLifecycleService } from '@/modules/websocket/services/chat-run-lifecycle.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { reconcileInterruptedOpenCodeRuns } from '@/modules/websocket/services/opencode-run-recovery.service.js';

async function withDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-reconciliation-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const originals = {
    start: chatRunLifecycleService.start,
    restart: chatRunLifecycleService.restart,
    health: providerRuntimeService.getHealth,
    children: providerRuntimeService.listChildActivity,
    approvals: providerRuntimeService.getPendingApprovalsForSession,
    abort: providerRuntimeService.abort,
  };
  try { await run(); } finally {
    chatRunLifecycleService.start = originals.start;
    chatRunLifecycleService.restart = originals.restart;
    providerRuntimeService.getHealth = originals.health;
    providerRuntimeService.listChildActivity = originals.children;
    providerRuntimeService.getPendingApprovalsForSession = originals.approvals;
    providerRuntimeService.abort = originals.abort;
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function seed(sessionId: string, now: number): void {
  sessionsDb.createAppSession(sessionId, 'opencode', '/workspace/reconciliation');
  sessionRunStateDb.beginRun({ sessionId, provider: 'opencode', now, continuationOptions: { model: 'kept' } });
}

function noRuntimeEvidence(): void {
  providerRuntimeService.getHealth = () => ({ state: 'missing', startedAt: null, lastOutputAt: null, exitCode: null });
  providerRuntimeService.listChildActivity = () => [];
  providerRuntimeService.getPendingApprovalsForSession = () => [];
}

test('startup reconciliation stalls orphaned running and recovering generations once without runtime calls', async () => {
  await withDatabase(() => {
    seed('running', 10);
    seed('recovering', 10);
    const recovering = sessionRunStateDb.getById('recovering')!;
    sessionRunStateDb.markStalled('recovering', recovering.generation, 'legacy', 20, 11);
    sessionRunStateDb.claimRecovery('recovering', recovering.generation, 3, 20);
    noRuntimeEvidence();
    let calls = 0;
    chatRunLifecycleService.start = async () => { calls += 1; throw new Error('must not start'); };
    chatRunLifecycleService.restart = async () => { calls += 1; throw new Error('must not restart'); };
    providerRuntimeService.abort = async () => { calls += 1; return true; };

    assert.equal(reconcileInterruptedOpenCodeRuns({ now: () => 100 }), 2);
    assert.equal(reconcileInterruptedOpenCodeRuns({ now: () => 200 }), 0);
    for (const id of ['running', 'recovering']) {
      const state = sessionRunStateDb.getById(id)!;
      assert.equal(state.lifecycleState, 'stalled');
      assert.equal(state.terminalReason, 'stalled');
      assert.match(state.terminalMessage ?? '', /restarted.*Restart/i);
    }
    assert.equal(calls, 0);
  });
});

test('startup reconciliation preserves live current runs and existing outcomes', async () => {
  await withDatabase(() => {
    seed('live', 10);
    const liveRun = chatRunRegistry.startRun({ appSessionId: 'live', provider: 'opencode', providerSessionId: null, connection: null, userId: null });
    assert.ok(liveRun);
    for (const id of ['stalled', 'failed', 'exited', 'manual', 'exhausted', 'completed']) seed(id, 10);
    for (const id of ['stalled', 'exhausted']) {
      const state = sessionRunStateDb.getById(id)!;
      sessionRunStateDb.markStalled(id, state.generation, id, 20, 11);
    }
    const failed = sessionRunStateDb.getById('failed')!;
    sessionRunStateDb.recordTerminal('failed', failed.generation, { lifecycleState: 'failed', terminalReason: 'provider_error', now: 12 });
    const exited = sessionRunStateDb.getById('exited')!;
    sessionRunStateDb.recordTerminal('exited', exited.generation, { lifecycleState: 'exited', terminalReason: 'process_exited', now: 12 });
    const manual = sessionRunStateDb.getById('manual')!;
    sessionRunStateDb.requestManualStop('manual', manual.generation, 12);
    const exhausted = sessionRunStateDb.getById('exhausted')!;
    sessionRunStateDb.markRecoveryExhausted('exhausted', exhausted.generation, 'exhausted', 12);
    const completed = sessionRunStateDb.getById('completed')!;
    sessionRunStateDb.recordTerminal('completed', completed.generation, { lifecycleState: 'completed', terminalReason: 'completed', now: 12 });
    noRuntimeEvidence();

    assert.equal(reconcileInterruptedOpenCodeRuns({ now: () => 100 }), 0);
    assert.equal(sessionRunStateDb.getById('live')?.lifecycleState, 'running');
    assert.deepEqual(['stalled', 'failed', 'exited', 'manual', 'exhausted', 'completed'].map((id) => sessionRunStateDb.getById(id)?.lifecycleState), ['stalled', 'failed', 'exited', 'manually_stopped', 'recovery_exhausted', 'completed']);
  });
});
