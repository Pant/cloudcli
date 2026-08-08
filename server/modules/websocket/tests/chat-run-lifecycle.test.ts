import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionRunStateDb, sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunLifecycleService } from '@/modules/websocket/services/chat-run-lifecycle.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  send(data: string): void { this.frames.push(JSON.parse(data) as Record<string, unknown>); }
}

async function withDatabase(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-run-lifecycle-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try { await run(); } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('normal execution persists options, streams progress, and records completion', async () => {
  await withDatabase(async () => {
    sessionsDb.createAppSession('normal-run', 'opencode', '/workspace/normal');
    const originalRun = providerRuntimeService.run;
    providerRuntimeService.run = async (_provider, command, options, writer) => {
      assert.equal(command, 'hello');
      assert.equal(options.sessionId, 'normal-run');
      writer.send({ kind: 'text', provider: 'opencode', sessionId: 'native', content: 'answer' });
      writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'native', exitCode: 0 });
    };
    try {
      const connection = new FakeConnection();
      await chatRunLifecycleService.start({
        sessionId: 'normal-run', command: 'hello', connection,
        options: { model: 'model-a', agent: 'agent-a', effort: 'high', attachments: [{ path: 'secret' }] },
      });
      await new Promise((resolve) => setImmediate(resolve));
      const state = sessionRunStateDb.getById('normal-run');
      assert.equal(state?.lifecycleState, 'completed');
      assert.deepEqual(state?.continuationOptions, {
        model: 'model-a', effort: 'high', agent: 'agent-a', projectPath: '/workspace/normal', cwd: '/workspace/normal',
      });
      assert.equal(connection.frames.some((frame) => frame.kind === 'text' && frame.sessionId === 'normal-run'), true);
      assert.equal(connection.frames.every((frame) => frame.kind === 'session_upserted' || typeof frame.generation === 'number'), true);
      assert.equal(sessionsDb.getSessionById('normal-run')?.model, 'model-a');
      assert.equal(sessionsDb.getSessionById('normal-run')?.agent, 'agent-a');
    } finally { providerRuntimeService.run = originalRun; }
  });
});

test('detached manual child restart sends Continue and buffers replay until attachment', async () => {
  await withDatabase(async () => {
    sessionsDb.createSession('parent-native', 'opencode', '/workspace/child');
    const childId = sessionsDb.createSession('child-native', 'opencode', '/workspace/child', 'Child', undefined, undefined, null, 'Code', 'parent-native');
    const originalRun = providerRuntimeService.run;
    let release!: () => void;
    providerRuntimeService.run = async (_provider, command, options, writer) => {
      assert.equal(command, 'Continue');
      assert.equal(options.sessionId, childId);
      writer.send({ kind: 'text', provider: 'opencode', sessionId: 'child-native', content: 'detached' });
      await new Promise<void>((resolve) => { release = resolve; });
    };
    try {
      const result = await chatRunLifecycleService.manualStart(childId);
      assert.equal(result.sessionId, childId);
      assert.equal(chatRunRegistry.replayEvents(childId, 0)[0]?.content, 'detached');
      const connection = new FakeConnection();
      assert.equal(chatRunRegistry.attachConnection(childId, connection), true);
      for (const event of chatRunRegistry.replayEvents(childId, 0)) connection.send(JSON.stringify(event));
      assert.equal(connection.frames[0]?.content, 'detached');
      assert.equal(sessionRunStateDb.getById(childId)?.desiredState, 'running');
      release();
      await new Promise((resolve) => setImmediate(resolve));
    } finally { providerRuntimeService.run = originalRun; }
  });
});

test('OpenCode retry preserves the canonical session model over malformed retry options', async () => {
  await withDatabase(async () => {
    sessionsDb.createSession('ses_01e8a163affeaSq1fJklN5TdER', 'opencode', '/workspace/retry');
    sessionsDb.setSessionModel('ses_01e8a163affeaSq1fJklN5TdER', 'cloudcli-openai/gpt-5.6-sol');
    const originalRun = providerRuntimeService.run;
    providerRuntimeService.run = async (provider, command, options) => {
      assert.equal(provider, 'opencode');
      assert.equal(command, 'Continue');
      assert.equal(options.model, 'cloudcli-openai/gpt-5.6-sol');
    };
    try {
      await chatRunLifecycleService.restart({
        sessionId: 'ses_01e8a163affeaSq1fJklN5TdER',
        options: { model: 'gpt-5.6-sol/' },
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally { providerRuntimeService.run = originalRun; }
  });
});

test('manual stop is durable before a failed abort and late completion cannot clear it', async () => {
  await withDatabase(async () => {
    sessionsDb.createAppSession('stop-run', 'opencode', '/workspace/stop');
    const originalRun = providerRuntimeService.run;
    const originalAbort = providerRuntimeService.abort;
    let writerRef: Parameters<typeof providerRuntimeService.run>[3] | null = null;
    providerRuntimeService.run = async (_provider, _command, _options, writer) => {
      writerRef = writer;
      await new Promise(() => undefined);
    };
    providerRuntimeService.abort = async () => {
      assert.equal(sessionRunStateDb.getById('stop-run')?.lifecycleState, 'manually_stopped');
      return false;
    };
    try {
      await chatRunLifecycleService.manualStart('stop-run');
      assert.equal(await chatRunLifecycleService.stop('stop-run'), false);
      assert.ok(writerRef);
      (writerRef as Parameters<typeof providerRuntimeService.run>[3]).send({ kind: 'complete', provider: 'opencode', sessionId: 'native', exitCode: 0 });
      const state = sessionRunStateDb.getById('stop-run');
      assert.equal(state?.desiredState, 'stopped');
      assert.equal(state?.lifecycleState, 'manually_stopped');
    } finally {
      providerRuntimeService.run = originalRun;
      providerRuntimeService.abort = originalAbort;
    }
  });
});

test('structured nonzero termination persists immutable diagnostics once and exposes only safe complete fields', async () => {
  await withDatabase(async () => {
    sessionsDb.createAppSession('failed-run', 'opencode', '/workspace/failed');
    const originalRun = providerRuntimeService.run;
    providerRuntimeService.run = async (_provider, _command, _options, writer) => {
      writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'native-secret', exitCode: 7 });
      return {
        startedAt: 100, endedAt: 200, lastOutputAt: 150, exitCode: 7, signal: null,
        diagnostic: { runId: 'safe-run', relativePath: 'safe-run' }, stderrTail: 'bounded failure',
        resources: { end: { scope: 'container-cgroup-v2', capturedAt: 190, memoryPeakBytes: 1234 } },
      };
    };
    try {
      const connection = new FakeConnection();
      await chatRunLifecycleService.start({ sessionId: 'failed-run', connection });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sessionRunStateDb.getById('failed-run')?.lifecycleState, 'failed');
      const history = sessionRunStateDb.listRecentHistory(10, 'failed-run');
      assert.equal(history.length, 1);
      assert.equal(history[0]?.exitCode, 7);
      assert.equal(history[0]?.diagnostic?.relativePath, 'safe-run');
      assert.equal(history[0]?.stderrTail, 'bounded failure');
      assert.equal(history[0]?.resources?.end?.memoryPeakBytes, 1234);
      const complete = connection.frames.find((frame) => frame.kind === 'complete');
      assert.equal(complete?.sessionId, 'failed-run');
      assert.equal(complete?.actualSessionId, 'failed-run');
      assert.equal(JSON.stringify(complete).includes('safe-run'), false);
      assert.equal(JSON.stringify(complete).includes('bounded failure'), false);
      assert.equal(JSON.stringify(complete).includes('native-secret'), false);
    } finally { providerRuntimeService.run = originalRun; }
  });
});

test('signal-only result is process-exited and runtime rejection evidence is recorded once', async () => {
  await withDatabase(async () => {
    const originalRun = providerRuntimeService.run;
    try {
      sessionsDb.createAppSession('signal-run', 'opencode', '/workspace/signal');
      providerRuntimeService.run = async () => ({
        startedAt: 10, endedAt: 20, lastOutputAt: null, exitCode: null, signal: 'SIGTERM', stderrTail: '',
      });
      await chatRunLifecycleService.start({ sessionId: 'signal-run' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sessionRunStateDb.getById('signal-run')?.lifecycleState, 'exited');
      assert.equal(sessionRunStateDb.listRecentHistory(10, 'signal-run')[0]?.signal, 'SIGTERM');

      sessionsDb.createAppSession('spawn-run', 'opencode', '/workspace/spawn');
      providerRuntimeService.run = async () => {
        const error = new Error('spawn ENOENT') as Error & { runtimeResult?: unknown };
        error.runtimeResult = { startedAt: 30, endedAt: 31, lastOutputAt: null, exitCode: null, signal: null, stderrTail: 'spawn ENOENT' };
        throw error;
      };
      await chatRunLifecycleService.start({ sessionId: 'spawn-run' });
      await new Promise((resolve) => setImmediate(resolve));
      const history = sessionRunStateDb.listRecentHistory(10, 'spawn-run');
      assert.equal(history.length, 1);
      assert.equal(history[0]?.terminalMessage, 'spawn ENOENT');
      assert.equal(history[0]?.stderrTail, 'spawn ENOENT');
    } finally { providerRuntimeService.run = originalRun; }
  });
});
