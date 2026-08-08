import type { ServerEvent } from '../../contexts/webSocketTypes';

export const SESSION_ACTIVITY_DEBOUNCE_MS = 100;
export const SESSION_ACTIVITY_ACTIVE_POLL_MS = 1_000;
export const SESSION_ACTIVITY_IDLE_POLL_MS = 15_000;

const lifecycleEventKinds = new Set([
  'complete',
  'session_upserted',
  'session_updated',
  'session_created',
  'session_status',
  'lifecycle_status',
  'status',
]);

export const isLifecycleRelevantEvent = (event: ServerEvent): boolean => {
  const kind = event.kind ?? event.type;
  if (!kind) return false;
  return lifecycleEventKinds.has(kind)
    || kind.startsWith('session_')
    || kind.includes('lifecycle')
    || kind.endsWith('_complete');
};

export const getSessionActivityPollInterval = (
  processingCount: number,
  lifecycleStatuses: Iterable<string>,
): number => processingCount > 0 || [...lifecycleStatuses].some((status) => status === 'running' || status === 'recovering')
  ? SESSION_ACTIVITY_ACTIVE_POLL_MS
  : SESSION_ACTIVITY_IDLE_POLL_MS;

export interface SessionActivitySyncController {
  invalidate: (immediate?: boolean) => void;
  setPollInterval: (intervalMs: number) => void;
  dispose: () => void;
}

type Timer = ReturnType<typeof setTimeout>;

export const createSessionActivitySyncController = ({
  refresh,
  debounceMs = SESSION_ACTIVITY_DEBOUNCE_MS,
}: {
  refresh: () => Promise<void>;
  debounceMs?: number;
}): SessionActivitySyncController => {
  let disposed = false;
  let inFlight = false;
  let trailing = false;
  let debounceTimer: Timer | null = null;
  let pollTimer: Timer | null = null;
  let pollIntervalMs = SESSION_ACTIVITY_IDLE_POLL_MS;

  const clear = (timer: Timer | null) => {
    if (timer !== null) clearTimeout(timer);
  };

  const schedulePoll = () => {
    clear(pollTimer);
    if (disposed) return;
    pollTimer = setTimeout(() => run(), pollIntervalMs);
  };

  const run = async () => {
    if (disposed) return;
    if (inFlight) {
      trailing = true;
      return;
    }
    inFlight = true;
    clear(pollTimer);
    pollTimer = null;
    try {
      await refresh();
    } finally {
      inFlight = false;
      if (!disposed && trailing) {
        trailing = false;
        void run();
      } else if (!disposed) {
        schedulePoll();
      }
    }
  };

  const invalidate = (immediate = false) => {
    if (disposed) return;
    if (inFlight) {
      trailing = true;
      return;
    }
    clear(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void run();
    }, immediate ? 0 : debounceMs);
  };

  return {
    invalidate,
    setPollInterval(intervalMs) {
      if (pollIntervalMs === intervalMs) return;
      pollIntervalMs = intervalMs;
      schedulePoll();
    },
    dispose() {
      disposed = true;
      trailing = false;
      clear(debounceTimer);
      clear(pollTimer);
    },
  };
};
