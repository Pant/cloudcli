export type RetryPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

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

export function isCurrentWebSocketLifecycle(
  activeLifecycle: number,
  callbackLifecycle: number,
): boolean {
  return activeLifecycle === callbackLifecycle;
}
