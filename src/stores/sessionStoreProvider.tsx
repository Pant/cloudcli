import { type ReactNode } from 'react';

import { useAuth } from '../components/auth/context/authContextContract';

import { getUserCacheNamespace } from './sessionMessageCache';
import { SessionStoreContext } from './sessionStoreContext';
import { useSessionStore } from './useSessionStore';

export function SessionStoreProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const sessionStore = useSessionStore({
    userNamespace: getUserCacheNamespace(user),
    realtimeCommitIntervalMs: 100,
  });

  return (
    <SessionStoreContext.Provider value={sessionStore}>
      {children}
    </SessionStoreContext.Provider>
  );
}
