import { useEffect } from 'react';

import { useSessionStoreContext } from './sessionStoreContext';

/**
 * Requests durable browser storage for the authenticated user's message cache.
 * Transcript caching is otherwise driven by opened sessions or explicit sync.
 */
export function SessionMessageCacheCoordinator() {
  const sessionStore = useSessionStoreContext();

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void sessionStore.requestCachePersistence().finally(() => sessionStore.refreshCacheStorageStatus(false));
    });
    return () => { cancelled = true; };
  }, [sessionStore]);

  return null;
}
