import { createContext, useContext } from 'react';

import type { SessionStore } from './useSessionStore';

export const SessionStoreContext = createContext<SessionStore | null>(null);

export function useSessionStoreContext(): SessionStore {
  const sessionStore = useContext(SessionStoreContext);
  if (!sessionStore) {
    throw new Error('useSessionStoreContext must be used within a SessionStoreProvider');
  }
  return sessionStore;
}
