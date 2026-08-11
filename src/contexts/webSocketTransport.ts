export type RetryPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

import type { WebSocketTransportState } from './webSocketTypes';

export function getWebSocketTransportState(options: {
  canConnect: boolean;
  isAuthLoading: boolean;
  isConnected: boolean;
  hasConnected: boolean;
  replayingSubscriptions: number;
}): WebSocketTransportState {
  if (options.isAuthLoading) return 'idle';
  if (!options.canConnect) return 'offline';
  if (!options.isConnected) return options.hasConnected ? 'degraded' : 'connecting';
  if (options.replayingSubscriptions > 0) return 'replaying';
  return 'connected';
}

export const DEFAULT_WEBSOCKET_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
};

export function getWebSocketRetryDelay(
  attempt: number,
  randomValue: number,
  policy: RetryPolicy = DEFAULT_WEBSOCKET_RETRY_POLICY,
): number {
  const boundedAttempt = Math.max(0, Math.floor(attempt));
  const exponentialDelay = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * (2 ** boundedAttempt),
  );
  const boundedRandom = Math.min(1, Math.max(0, randomValue));
  const jitterMultiplier = 1 + ((boundedRandom * 2) - 1) * policy.jitterRatio;
  return Math.min(policy.maxDelayMs, Math.round(exponentialDelay * jitterMultiplier));
}

export function shouldRetryWebSocketClose(options: {
  intentional: boolean;
  isCurrentSocket: boolean;
  canConnect: boolean;
}): boolean {
  return !options.intentional && options.isCurrentSocket && options.canConnect;
}

export function shouldArmWebSocketReload(options: {
  intentional: boolean;
  isCurrentSocket: boolean;
  canConnect: boolean;
  hasConnected: boolean;
  reloadPending: boolean;
  reloadConsumed: boolean;
}): boolean {
  return options.hasConnected
    && !options.reloadPending
    && !options.reloadConsumed
    && shouldRetryWebSocketClose(options);
}

export function isCurrentWebSocketLifecycle(
  activeLifecycle: number,
  callbackLifecycle: number,
): boolean {
  return activeLifecycle === callbackLifecycle;
}

export function shouldReloadForClientBuild(options: {
  currentBuildId: string;
  servedBuildId: string | null;
  reloadPending: boolean;
}): boolean {
  return !options.reloadPending
    && options.servedBuildId !== null
    && options.servedBuildId.length > 0
    && options.servedBuildId !== options.currentBuildId;
}

export function getClientBuildVersionUrl(baseUri: string): string {
  return new URL('cloudcli-version.json', baseUri).toString();
}

export function parseClientBuildResource(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('build' in value)) return null;
  return typeof value.build === 'string' && value.build.length > 0 ? value.build : null;
}
