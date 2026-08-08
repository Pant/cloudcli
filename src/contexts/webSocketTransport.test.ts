import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getWebSocketRetryDelay,
  isCurrentWebSocketLifecycle,
  shouldRetryWebSocketClose,
} from './webSocketTransport';

test('retry delay uses bounded exponential backoff with bounded jitter', () => {
  const policy = { baseDelayMs: 1_000, maxDelayMs: 8_000, jitterRatio: 0.2 };
  assert.equal(getWebSocketRetryDelay(0, 0, policy), 800);
  assert.equal(getWebSocketRetryDelay(0, 1, policy), 1_200);
  assert.equal(getWebSocketRetryDelay(3, 0.5, policy), 8_000);
  assert.equal(getWebSocketRetryDelay(20, 1, policy), 8_000);
});

test('an opened connection can reset retry calculation to the first attempt', () => {
  const policy = { baseDelayMs: 1_000, maxDelayMs: 8_000, jitterRatio: 0 };
  assert.equal(getWebSocketRetryDelay(4, 0.5, policy), 8_000);
  assert.equal(getWebSocketRetryDelay(0, 0.5, policy), 1_000);
});

test('only an unexpected close of the current connectable socket retries', () => {
  assert.equal(shouldRetryWebSocketClose({ intentional: false, isCurrentSocket: true, canConnect: true }), true);
  assert.equal(shouldRetryWebSocketClose({ intentional: true, isCurrentSocket: true, canConnect: true }), false);
  assert.equal(shouldRetryWebSocketClose({ intentional: false, isCurrentSocket: false, canConnect: true }), false);
  assert.equal(shouldRetryWebSocketClose({ intentional: false, isCurrentSocket: true, canConnect: false }), false);
});

test('lifecycle epochs fence stale socket callbacks', () => {
  assert.equal(isCurrentWebSocketLifecycle(4, 4), true);
  assert.equal(isCurrentWebSocketLifecycle(5, 4), false);
});
