import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  buildNotificationPayload,
  notifyRunStopped,
  notifyTaskCompleted,
  setNotificationWebPushSenderForTests,
} from '@/modules/notifications/index.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

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
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('notification payload uses the app session id for a provider session id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-1', 'claude-native-1');

    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'claude-native-1',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });

    assert.equal(payload.data.sessionId, 'app-session-1');
    assert.match(payload.data.tag, /app-session-1/);
    assert.equal(payload.data.stopReason, 'completed');
    assert.equal(payload.data.replyEligible, true);
    assert.equal(payload.data.severity, 'info');
  });
});

test('notification payload exposes normalized informational and non-informational severity', async () => {
  await withIsolatedDatabase(() => {
    const informationalPayload = buildNotificationPayload({
      provider: 'system',
      severity: ' INFO ',
    });
    const warningPayload = buildNotificationPayload({
      provider: 'system',
      severity: 'WARNING',
    });

    assert.equal(informationalPayload.data.severity, 'info');
    assert.equal(warningPayload.data.severity, 'warning');
  });
});

test('root, child, and completed Task events dispatch enabled Web Push with app metadata and dedupe', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root-native', 'opencode', '/workspace/demo', undefined, undefined, undefined, undefined, undefined, null);
    sessionsDb.createSession('child-native', 'opencode', '/workspace/demo', undefined, undefined, undefined, undefined, undefined, 'root-native');
    const userId = Number(userDb.createUser('notification-user', 'hash').id);
    notificationPreferencesDb.updatePreferences(userId, { channels: { webPush: true }, events: { stop: true } });
    pushSubscriptionsDb.saveSubscription(userId, 'https://push.example/subscription', 'p256dh', 'auth');
    const deliveries: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    setNotificationWebPushSenderForTests(async (subscription, payload) => {
      deliveries.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload as string) as Record<string, unknown> });
      return {} as never;
    });
    try {
      notifyRunStopped({ userId, provider: 'opencode', sessionId: 'root-native' });
      notifyRunStopped({ userId, provider: 'opencode', sessionId: 'child-native' });
      notifyTaskCompleted({ userId, sessionId: 'root-native', taskId: 'task-1', taskSummary: 'Review authentication' });
      notifyTaskCompleted({ userId, sessionId: 'root-native', taskId: 'task-1', taskSummary: 'Review authentication' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(deliveries.length, 3);
      assert.equal(deliveries.every((delivery) => delivery.endpoint === 'https://push.example/subscription'), true);
      const task = deliveries.map((delivery) => delivery.payload).find((payload) => (payload.data as { code?: string }).code === 'task.completed');
      assert.deepEqual(task?.data, {
        sessionId: 'root-native', code: 'task.completed', provider: 'opencode', sessionName: null,
        severity: 'info', stopReason: null, replyEligible: false,
        tag: 'opencode:root-native:task.completed', completionType: 'task', taskId: 'task-1', taskSummary: 'Review authentication',
      });
    } finally {
      setNotificationWebPushSenderForTests(null);
    }
  });
});

test('Task completion retains stop preference filtering', async () => {
  await withIsolatedDatabase(async () => {
    const userId = Number(userDb.createUser('disabled-user', 'hash').id);
    notificationPreferencesDb.updatePreferences(userId, { channels: { webPush: true }, events: { stop: false } });
    pushSubscriptionsDb.saveSubscription(userId, 'https://push.example/disabled', 'p256dh', 'auth');
    let deliveries = 0;
    setNotificationWebPushSenderForTests(async () => { deliveries += 1; return {} as never; });
    try {
      notifyTaskCompleted({ userId, sessionId: 'session-disabled', taskId: 'task-disabled' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(deliveries, 0);
    } finally { setNotificationWebPushSenderForTests(null); }
  });
});
