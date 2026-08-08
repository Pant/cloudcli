export type TokenUsageSnapshot = Record<string, unknown>;

const hasOwn = (value: TokenUsageSnapshot, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Read a token counter without turning missing or malformed values into zero. */
function readTokenCounter(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readCurrentWindow(snapshot: TokenUsageSnapshot): number | null {
  const candidates = [
    hasOwn(snapshot, 'windowTokens') ? snapshot.windowTokens : undefined,
    hasOwn(snapshot, 'window_tokens') ? snapshot.window_tokens : undefined,
  ];
  for (const candidate of candidates) {
    const parsed = readTokenCounter(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function hasNonZeroCumulativeUsage(snapshot: TokenUsageSnapshot): boolean {
  const cumulativeFields = [
    snapshot.used,
    snapshot.total_tokens,
    snapshot.inputTokens,
    snapshot.input_tokens,
    snapshot.outputTokens,
    snapshot.output_tokens,
  ];

  if (cumulativeFields.some((value) => {
    const parsed = readTokenCounter(value);
    return parsed !== null && parsed > 0;
  })) {
    return true;
  }

  const breakdown = snapshot.breakdown;
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
    return false;
  }

  const breakdownRecord = breakdown as TokenUsageSnapshot;
  return [
    breakdownRecord.input,
    breakdownRecord.output,
  ].some((value) => {
    const parsed = readTokenCounter(value);
    return parsed !== null && parsed > 0;
  });
}

/**
 * Merge a provider snapshot into the last snapshot shown for the session.
 *
 * Provider REST/live payloads are not guaranteed to contain every token field
 * on every update. The current-window value is therefore only replaced by a
 * finite, non-negative value. A zero accompanied by cumulative usage is a
 * known provider placeholder, not evidence that the current context is empty.
 * Explicit zero snapshots with no cumulative usage remain valid (for example,
 * a newly-created or compacted context).
 */
export function stabilizeTokenUsageSnapshot(
  previous: TokenUsageSnapshot | null | undefined,
  incoming: unknown,
): TokenUsageSnapshot | null {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return previous ?? null;
  }

  const next = {
    ...(previous ?? {}),
    ...(incoming as TokenUsageSnapshot),
  };
  const incomingSnapshot = incoming as TokenUsageSnapshot;
  const hasIncomingWindow = hasOwn(incomingSnapshot, 'windowTokens') || hasOwn(incomingSnapshot, 'window_tokens');
  const incomingWindow = readCurrentWindow(incomingSnapshot);
  const previousWindow = previous ? readCurrentWindow(previous) : null;
  const isPlaceholderZero = incomingWindow === 0 && hasNonZeroCumulativeUsage(incomingSnapshot);

  if (!hasIncomingWindow || incomingWindow === null || isPlaceholderZero) {
    if (previousWindow !== null) {
      next.windowTokens = previousWindow;
    } else {
      delete next.windowTokens;
    }
    delete next.window_tokens;
    return next;
  }

  next.windowTokens = incomingWindow;
  delete next.window_tokens;
  return next;
}
