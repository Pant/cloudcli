import type { ChatResponseMetadata } from '../types/types';

const ATHENS_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Athens',
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const TOKEN_FORMATTER = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
});

function isValidTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function formatAthensResponseTimestamp(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  const parts = Object.fromEntries(
    ATHENS_DATE_TIME_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  if (!parts.day || !parts.month || !parts.year || !parts.hour || !parts.minute) return null;

  return `${Number(parts.day)}/${Number(parts.month)}/${parts.year} ${parts.hour}:${parts.minute}`;
}

export function formatResponseTokenCount(tokens: number): string | null {
  return isValidTokenCount(tokens) ? TOKEN_FORMATTER.format(tokens) : null;
}

export type FormattedResponseMetadata = {
  timestamp: string;
  inputTokens: string;
  outputTokens: string;
};

export function formatResponseMetadata(
  metadata: ChatResponseMetadata | null | undefined,
): FormattedResponseMetadata | null {
  if (!metadata) return null;

  const timestamp = formatAthensResponseTimestamp(metadata.timestamp);
  const inputTokens = formatResponseTokenCount(metadata.inputTokens);
  const outputTokens = formatResponseTokenCount(metadata.outputTokens);
  if (!timestamp || inputTokens === null || outputTokens === null) return null;

  return { timestamp, inputTokens, outputTokens };
}
