import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

type ReloadSafetyValue = {
  isReloadSafe: boolean;
  blockers: readonly string[];
  setReloadBlocker: (id: string, blocked: boolean) => void;
  confirmReload: (message?: string) => boolean;
};

const ReloadSafetyContext = createContext<ReloadSafetyValue | null>(null);

export function ReloadSafetyProvider({ children }: { children: ReactNode }) {
  const [blockers, setBlockers] = useState<Set<string>>(() => new Set());
  const setReloadBlocker = useCallback((id: string, blocked: boolean) => {
    setBlockers((current) => {
      const next = new Set(current);
      if (blocked) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const isReloadSafe = blockers.size === 0;
  const confirmReload = useCallback((message = 'Unsaved work may be lost. Continue?') => (
    blockers.size === 0 || window.confirm(message)
  ), [blockers.size]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (blockers.size === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [blockers.size]);

  const value = useMemo(() => ({ isReloadSafe, blockers: [...blockers], setReloadBlocker, confirmReload }), [blockers, confirmReload, isReloadSafe, setReloadBlocker]);
  return <ReloadSafetyContext.Provider value={value}>{children}</ReloadSafetyContext.Provider>;
}

// This context intentionally colocates its small hook with its provider.
// eslint-disable-next-line react-refresh/only-export-components
export function useReloadSafety() {
  const context = useContext(ReloadSafetyContext);
  if (!context) throw new Error('useReloadSafety must be used within ReloadSafetyProvider');
  return context;
}
