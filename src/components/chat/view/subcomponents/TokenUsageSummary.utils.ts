export type TokenUsageSnapshot = Record<string, unknown>;

export type TokenUsageBadgeState = {
  hasSnapshot: boolean;
  hasCurrentWindow: boolean;
  current: number | null;
  maximum: number | null;
  percentage: number | null;
  currentLabel: string;
  maximumLabel: string | null;
  percentageLabel: string | null;
  displayLabel: string;
  title: string;
  ariaLabel: string;
};

/** Read a usage value without turning missing or malformed data into a real zero. */
export function readTokenUsageNumber(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
}

export function formatExactTokenCount(value: number): string {
  return value.toLocaleString();
}

/** Clamp provider counters to the displayable percentage range. */
export function calculateTokenUsagePercentage(current: number, maximum: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0) {
    return null;
  }

  return Math.min(100, Math.max(0, (current / maximum) * 100));
}

export function formatTokenUsagePercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return `${Math.round(value)}%`;
}

export function buildTokenUsageBadgeState(
  usage: TokenUsageSnapshot | null | undefined,
): TokenUsageBadgeState {
  if (!usage) {
    return {
      hasSnapshot: false,
      hasCurrentWindow: false,
      current: null,
      maximum: null,
      percentage: null,
      currentLabel: '—',
      maximumLabel: null,
      percentageLabel: null,
      displayLabel: '—',
      title: 'Current context unavailable while waiting for a usage snapshot',
      ariaLabel: 'Current context unavailable while waiting for a usage snapshot. Show token usage details.',
    };
  }

  const currentWindowTokens = readTokenUsageNumber(usage.windowTokens);
  const advertisedMaximum = readTokenUsageNumber(usage.total);
  const maximum = advertisedMaximum !== null && advertisedMaximum > 0 ? advertisedMaximum : null;

  if (currentWindowTokens === null) {
    const maximumLabel = maximum === null ? null : formatTokenCount(maximum);
    const capacityDescription = maximum === null
      ? 'context window capacity unavailable'
      : `context window capacity is ${formatExactTokenCount(maximum)} tokens`;

    return {
      hasSnapshot: true,
      hasCurrentWindow: false,
      current: null,
      maximum,
      percentage: null,
      currentLabel: '—',
      maximumLabel,
      percentageLabel: null,
      displayLabel: '—',
      title: `Current context unavailable; ${capacityDescription}`,
      ariaLabel: `Current context unavailable; ${capacityDescription}. Show token usage details.`,
    };
  }

  const current = Math.max(0, currentWindowTokens);
  const percentage = maximum === null ? null : calculateTokenUsagePercentage(current, maximum);
  const currentLabel = formatTokenCount(current);
  const maximumLabel = maximum === null ? null : formatTokenCount(maximum);
  const percentageLabel = formatTokenUsagePercentage(percentage);
  const exactCurrent = formatExactTokenCount(current);

  if (maximum === null || maximumLabel === null || percentageLabel === null) {
    return {
      hasSnapshot: true,
      hasCurrentWindow: true,
      current,
      maximum: null,
      percentage: null,
      currentLabel,
      maximumLabel: null,
      percentageLabel: null,
      displayLabel: `${currentLabel} tokens`,
      title: `${exactCurrent} current context tokens; context window capacity unavailable`,
      ariaLabel: `Current context: ${exactCurrent} tokens; context window capacity unavailable. Show token usage details.`,
    };
  }

  const exactMaximum = formatExactTokenCount(maximum);
  return {
    hasSnapshot: true,
    hasCurrentWindow: true,
    current,
    maximum,
    percentage,
    currentLabel,
    maximumLabel,
    percentageLabel,
    displayLabel: `${currentLabel} / ${maximumLabel} · ${percentageLabel}`,
    title: `${exactCurrent} current context tokens; ${exactMaximum}-token capacity (${percentageLabel} of context window)`,
    ariaLabel: `Current context: ${exactCurrent} of ${exactMaximum} tokens, ${percentageLabel} of context window capacity. Show token usage details.`,
  };
}
