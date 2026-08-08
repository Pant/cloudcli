import type { CostCommandData } from '../../hooks/useChatComposerState';

export type TokenUsageDetails = {
  /** Cumulative/session usage retained for the total row in the popup. */
  used: number;
  /** Current occupancy of the model context window, when reported. */
  windowTokens: number | null;
  maximum: number | null;
  windowPercentage: number | null;
  remaining: number | null;
  visualPercentage: number | null;
};

export const getTokenUsageDetails = (
  tokenUsage: CostCommandData['tokenUsage'],
): TokenUsageDetails => {
  const parsedUsed = Number(tokenUsage?.used ?? 0);
  const used = Number.isFinite(parsedUsed) ? Math.max(parsedUsed, 0) : 0;
  const rawWindowTokens = tokenUsage?.windowTokens;
  const parsedWindowTokens = rawWindowTokens == null ? Number.NaN : Number(rawWindowTokens);
  const windowTokens = Number.isFinite(parsedWindowTokens) ? Math.max(parsedWindowTokens, 0) : null;
  const parsedMaximum = Number(tokenUsage?.total);
  const maximum = Number.isFinite(parsedMaximum) && parsedMaximum > 0 ? parsedMaximum : null;

  if (maximum === null || windowTokens === null) {
    return {
      used,
      windowTokens,
      maximum,
      windowPercentage: null,
      remaining: null,
      visualPercentage: null,
    };
  }

  const percentage = (windowTokens / maximum) * 100;
  const clampedPercentage = Math.min(Math.max(percentage, 0), 100);

  return {
    used,
    windowTokens,
    maximum,
    windowPercentage: clampedPercentage,
    remaining: Math.max(maximum - windowTokens, 0),
    visualPercentage: clampedPercentage,
  };
};

export const formatPercentage = (value: number) => `${Math.round(value * 10) / 10}%`;
