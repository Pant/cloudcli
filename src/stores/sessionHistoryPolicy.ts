import type { NormalizedMessage } from './normalizedMessage';

export interface SessionHistoryRequestOptions {
  limit?: number | null;
  offset?: number;
}

export interface CompleteHistoryState {
  total: number;
  hasMore: false;
  offset: number;
}

/**
 * Build the history URL used by an ordinary session load. An omitted limit is
 * intentional: the sessions API treats the absence of `limit` as a request
 * for the complete transcript. Numeric limits remain available to the store's
 * legacy pagination API, but the chat view no longer uses them.
 */
export function buildSessionMessagesUrl(
  sessionId: string,
  options: SessionHistoryRequestOptions = {},
): string {
  const params = new URLSearchParams();
  if (options.limit !== null && options.limit !== undefined) {
    params.set('limit', String(options.limit));
    params.set('offset', String(options.offset ?? 0));
  }

  const query = params.toString();
  return `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ''}`;
}

/**
 * Complete transcript responses are authoritative rather than paginated,
 * even if an older backend response happens to include a truthy hasMore flag.
 */
export function normalizeCompleteHistoryState(
  messages: readonly NormalizedMessage[],
  reportedTotal?: unknown,
): CompleteHistoryState {
  const total = typeof reportedTotal === 'number' && Number.isFinite(reportedTotal)
    ? reportedTotal
    : messages.length;

  return {
    total,
    hasMore: false,
    offset: messages.length,
  };
}

export function getVisibleHistoryWindow<T>(
  messages: readonly T[],
  visibleCount: number,
): T[] {
  if (messages.length <= visibleCount || visibleCount === Infinity) {
    return [...messages];
  }
  return messages.slice(-visibleCount);
}

export interface LocalHistoryReveal {
  visibleCount: number;
  allMessagesLoaded: boolean;
}

export function revealLocalHistoryWindow(
  currentVisibleCount: number,
  totalMessages: number,
  chunkSize = 100,
): LocalHistoryReveal {
  if (currentVisibleCount === Infinity || totalMessages <= currentVisibleCount) {
    return {
      visibleCount: currentVisibleCount,
      allMessagesLoaded: true,
    };
  }

  const visibleCount = Math.min(currentVisibleCount + chunkSize, totalMessages);
  return {
    visibleCount,
    allMessagesLoaded: visibleCount >= totalMessages,
  };
}
