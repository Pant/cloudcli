import { useEffect } from 'react';

import { useSessionStoreContext } from './sessionStoreContext';

/**
 * Requests durable browser storage for the authenticated user's message cache.
 * Transcript caching is otherwise driven by opened sessions or explicit sync.
 */
export function SessionMessageCacheCoordinator() {
  const { requestCachePersistence, refreshCacheStorageStatus } = useSessionStoreContext();

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void requestCachePersistence().finally(() => refreshCacheStorageStatus(false));
    });
    return () => { cancelled = true; };
  }, [requestCachePersistence, refreshCacheStorageStatus]);

  return null;
}
