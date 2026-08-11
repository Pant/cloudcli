import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionActivitySyncController,
  getSessionActivityPollInterval,
  isLifecycleRelevantEvent,
  SESSION_ACTIVITY_ACTIVE_POLL_MS,
  SESSION_ACTIVITY_IDLE_POLL_MS,
} from './sessionActivitySync';

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const createScheduler = () => {
  const timers = new Map<number, () => void>();
  let id = 0;
  return {
    scheduler: {
      setTimeout(callback: () => void) { const next = ++id; timers.set(next, callback); return next as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout(timer: ReturnType<typeof setTimeout>) { timers.delete(timer as unknown as number); },
    },
    runNext() { const first = timers.entries().next().value as [number, () => void] | undefined; if (first) { timers.delete(first[0]); first[1](); } },
    size: () => timers.size,
  };
};

test('classifies completion, lifecycle/status, reconnect, and session events', () => {
  for (const kind of ['complete', 'lifecycle_status', 'status', 'session_upserted', 'session_deleted']) {
    assert.equal(isLifecycleRelevantEvent({ kind }), true, kind);
  }
  assert.equal(isLifecycleRelevantEvent({ kind: 'websocket_reconnected' }), false);
  assert.equal(isLifecycleRelevantEvent({ kind: 'message_delta' }), false);
});

test('uses fast active/transitional cadence and a slower idle safety cadence', () => {
  assert.equal(getSessionActivityPollInterval(1, []), SESSION_ACTIVITY_ACTIVE_POLL_MS);
  assert.equal(getSessionActivityPollInterval(0, ['recovering']), SESSION_ACTIVITY_ACTIVE_POLL_MS);
  assert.equal(getSessionActivityPollInterval(0, ['failed']), SESSION_ACTIVITY_IDLE_POLL_MS);
  assert.ok(SESSION_ACTIVITY_ACTIVE_POLL_MS <= 5_000);
  assert.ok(SESSION_ACTIVITY_IDLE_POLL_MS >= 60_000);
});

test('coalesces bursts and queues exactly one trailing refresh while in flight', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const controller = createSessionActivitySyncController({
    debounceMs: 1,
    refresh: async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
    },
  });
  controller.invalidate();
  controller.invalidate();
  await wait();
  assert.equal(calls, 1);
  controller.invalidate();
  controller.invalidate();
  release?.();
  await wait();
  assert.equal(calls, 2);
  controller.dispose();
});

test('immediate invalidation models mount, reconnect, focus, and visibility triggers', async () => {
  let calls = 0;
  const controller = createSessionActivitySyncController({ refresh: async () => { calls += 1; } });
  controller.invalidate(true);
  await wait();
  assert.equal(calls, 1);
  controller.dispose();
  controller.invalidate(true);
  await wait();
  assert.equal(calls, 1);
});

test('fallback polling pauses hidden/offline and resumes through validation', async () => {
  let visible = false;
  let online = true;
  let calls = 0;
  const timers = createScheduler();
  const controller = createSessionActivitySyncController({
    refresh: async () => { calls += 1; },
    scheduler: timers.scheduler,
    random: () => 0.5,
    isVisible: () => visible,
    isOnline: () => online,
  });
  controller.invalidate(true);
  assert.equal(timers.size(), 0);
  visible = true;
  online = false;
  controller.invalidate(true);
  assert.equal(timers.size(), 0);
  online = true;
  controller.invalidate(true);
  timers.runNext();
  await Promise.resolve();
  assert.equal(calls, 1);
  controller.dispose();
});
