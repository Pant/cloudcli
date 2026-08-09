import type { ServerEvent } from '../../contexts/webSocketTypes';
import { KeyedServerState } from '../../lib/serverState';

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
type Scheduler = {
  setTimeout: (callback: () => void, delay: number) => Timer;
  clearTimeout: (timer: Timer) => void;
};

// Browser timer functions require the Window receiver. Wrapping them keeps
// that receiver intact when the scheduler invokes them as object methods.
const defaultScheduler: Scheduler = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
};

export const createSessionActivitySyncController = ({
  refresh,
  debounceMs = SESSION_ACTIVITY_DEBOUNCE_MS,
  scheduler = defaultScheduler,
  random = Math.random,
  isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible',
  isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false,
}: {
  refresh: (signal?: AbortSignal) => Promise<void>;
  debounceMs?: number;
  scheduler?: Scheduler;
  random?: () => number;
  isVisible?: () => boolean;
  isOnline?: () => boolean;
}): SessionActivitySyncController => {
  let disposed = false;
  let trailing = false;
  let debounceTimer: Timer | null = null;
  let pollTimer: Timer | null = null;
  let pollIntervalMs = SESSION_ACTIVITY_IDLE_POLL_MS;
  const owner = new KeyedServerState(async (_key: 'activity', signal) => {
    await refresh(signal);
  });

  const clear = (timer: Timer | null) => {
    if (timer !== null) scheduler.clearTimeout(timer);
  };

  const schedulePoll = () => {
    clear(pollTimer);
    if (disposed) return;
    if (!isVisible() || !isOnline()) return;
    const jittered = Math.max(0, Math.round(pollIntervalMs * (0.9 + random() * 0.2)));
    pollTimer = scheduler.setTimeout(() => { void run(); }, jittered);
  };

  const run = async () => {
    if (disposed) return;
    if (owner.getSnapshot('activity').status === 'loading') {
      trailing = true;
      return;
    }
    clear(pollTimer);
    pollTimer = null;
    try {
      await owner.read('activity');
    } finally {
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
    owner.invalidate('activity');
    if (!isVisible() || !isOnline()) {
      clear(pollTimer);
      pollTimer = null;
      return;
    }
    if (owner.getSnapshot('activity').status === 'loading') {
      trailing = true;
      return;
    }
    clear(debounceTimer);
    debounceTimer = scheduler.setTimeout(() => {
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
      owner.dispose();
    },
  };
};
