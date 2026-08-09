import { useEffect } from 'react';

import { useSessionStoreContext } from './sessionStoreContext';

/**
 * Requests durable browser storage for the authenticated user's message cache.
 * Transcript caching is otherwise driven by opened sessions or explicit sync.
 */
export function SessionMessageCacheCoordinator() {
  const sessionStore = useSessionStoreContext();

  useEffect(() => {
    void sessionStore.requestCachePersistence();
  }, [sessionStore]);

  return null;
}
