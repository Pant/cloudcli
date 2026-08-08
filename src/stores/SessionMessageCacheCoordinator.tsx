import { useEffect, useRef } from 'react';

import { useWebSocket } from '../contexts/useWebSocket';
import type { ServerEvent } from '../contexts/webSocketTypes';

import { useSessionStoreContext } from './sessionStoreContext';
import { canRunSessionCacheSync } from './sessionMessageCacheCoordinator';

const MANIFEST_INTERVAL_MS = 45_000;
const EVENT_SYNC_DEBOUNCE_MS = 350;

function browserCanSync(): boolean {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return true;
}

/**
 * Keeps the authenticated user's complete message cache warm independently of
 * which project/session the chat UI has mounted. The websocket listener only
 * writes durable rows; visible in-memory ingestion remains owned by ChatInterface.
 */
export function SessionMessageCacheCoordinator() {
  const sessionStore = useSessionStoreContext();
  const { subscribe } = useWebSocket();
  const timerRef = useRef<number | null>(null);
  const coordinator = sessionStore.cacheCoordinator;

  useEffect(() => {
    const clearScheduledRun = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const runNow = () => {
      if (!browserCanSync()) return;
      void coordinator.reconcile();
    };

    const schedule = (delay = EVENT_SYNC_DEBOUNCE_MS) => {
      if (!browserCanSync()) return;
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        runNow();
      }, delay);
    };

    const handleEvent = (event: ServerEvent) => {
      if (event.kind === 'websocket_reconnected') {
        schedule(0);
        return;
      }

      if (event.kind === 'session_upserted' && typeof event.sessionId === 'string') {
        coordinator.invalidateSession(event.sessionId);
        schedule();
        return;
      }

      if (
        event.kind === 'complete'
        && event.success !== false
        && !event.aborted
        && typeof event.sessionId === 'string'
      ) {
        coordinator.invalidateSession(event.sessionId);
        // Let the store's serialized realtime persistence queue catch up before
        // canonical history replacement runs.
        schedule(EVENT_SYNC_DEBOUNCE_MS);
      }
    };

    const handleActivity = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      schedule(0);
    };

    const interval = window.setInterval(() => {
      if (canRunSessionCacheSync(document.visibilityState, navigator.onLine)) {
        runNow();
      }
    }, MANIFEST_INTERVAL_MS);

    const unsubscribe = subscribe(handleEvent);
    window.addEventListener('focus', handleActivity);
    window.addEventListener('online', handleActivity);
    document.addEventListener('visibilitychange', handleActivity);

    void sessionStore.requestCachePersistence();
    schedule(0);

    return () => {
      clearScheduledRun();
      window.clearInterval(interval);
      unsubscribe();
      window.removeEventListener('focus', handleActivity);
      window.removeEventListener('online', handleActivity);
      document.removeEventListener('visibilitychange', handleActivity);
    };
  }, [coordinator, sessionStore, subscribe]);

  return null;
}
