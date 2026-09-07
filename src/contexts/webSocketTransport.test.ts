import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getWebSocketRetryDelay,
  getWebSocketTransportState,
  isCurrentWebSocketLifecycle,
  shouldArmWebSocketReload,
  shouldRetryWebSocketClose,
} from './webSocketTransport';
import type { WebSocketContextType } from './webSocketTypes';

test('context contract exposes transport and subscriptions without retaining individual frames', () => {
  const contextKeys: Array<keyof WebSocketContextType> = [
    'ws', 'sendMessage', 'subscribe', 'isConnected', 'connectionEpoch', 'transportState',
  ];
  assert.equal(contextKeys.includes('latestMessage' as keyof WebSocketContextType), false);
});

test('retry delay uses bounded exponential backoff with bounded jitter', () => {
  const policy = { baseDelayMs: 1_000, maxDelayMs: 8_000, jitterRatio: 0.2 };
  assert.equal(getWebSocketRetryDelay(0, 0, policy), 800);
  assert.equal(getWebSocketRetryDelay(0, 1, policy), 1_200);
  assert.equal(getWebSocketRetryDelay(3, 0.5, policy), 8_000);
  assert.equal(getWebSocketRetryDelay(20, 1, policy), 8_000);
});

test('transport state maps authentication, reconnect degradation, and scoped replay signals', () => {
  assert.equal(getWebSocketTransportState({ canConnect: false, isAuthLoading: true, isConnected: false, hasConnected: false, replayingSubscriptions: 0 }), 'idle');
  assert.equal(getWebSocketTransportState({ canConnect: false, isAuthLoading: false, isConnected: false, hasConnected: false, replayingSubscriptions: 0 }), 'offline');
  assert.equal(getWebSocketTransportState({ canConnect: true, isAuthLoading: false, isConnected: false, hasConnected: false, replayingSubscriptions: 0 }), 'connecting');
  assert.equal(getWebSocketTransportState({ canConnect: true, isAuthLoading: false, isConnected: false, hasConnected: true, replayingSubscriptions: 0 }), 'degraded');
  assert.equal(getWebSocketTransportState({ canConnect: true, isAuthLoading: false, isConnected: true, hasConnected: true, replayingSubscriptions: 1 }), 'replaying');
  assert.equal(getWebSocketTransportState({ canConnect: true, isAuthLoading: false, isConnected: true, hasConnected: true, replayingSubscriptions: 0 }), 'connected');
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

test('reload arms once only after a healthy current connection closes unexpectedly', () => {
  const eligible = {
    intentional: false,
    isCurrentSocket: true,
    canConnect: true,
    hasConnected: true,
    reloadPending: false,
    reloadConsumed: false,
  };
  assert.equal(shouldArmWebSocketReload(eligible), true);
  assert.equal(shouldArmWebSocketReload({ ...eligible, hasConnected: false }), false);
  assert.equal(shouldArmWebSocketReload({ ...eligible, intentional: true }), false);
  assert.equal(shouldArmWebSocketReload({ ...eligible, isCurrentSocket: false }), false);
  assert.equal(shouldArmWebSocketReload({ ...eligible, canConnect: false }), false);
  assert.equal(shouldArmWebSocketReload({ ...eligible, reloadPending: true }), false);
  assert.equal(shouldArmWebSocketReload({ ...eligible, reloadConsumed: true }), false);
});

test('lifecycle epochs fence stale socket callbacks', () => {
  assert.equal(isCurrentWebSocketLifecycle(4, 4), true);
  assert.equal(isCurrentWebSocketLifecycle(5, 4), false);
});
