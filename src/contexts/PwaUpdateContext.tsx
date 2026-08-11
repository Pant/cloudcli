import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { activateWaitingServiceWorker, checkForPwaUpdate, subscribeToPwaRegistration } from '../lib/pwaRegistration';

import { useReloadSafety } from './ReloadSafetyContext';

type PwaUpdateValue = { updateReady: boolean; activateUpdate: () => boolean; postponeUpdate: () => void; checkForUpdate: () => Promise<void> };
const PwaUpdateContext = createContext<PwaUpdateValue | null>(null);

export function PwaUpdateProvider({ children }: { children: ReactNode }) {
  const [updateReady, setUpdateReady] = useState(false);
  const { isReloadSafe } = useReloadSafety();
  useEffect(() => subscribeToPwaRegistration(({ waiting }) => setUpdateReady(Boolean(waiting))), []);
  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cloudcli-pwa-update');
    const controllerChanged = () => { channel?.postMessage('reload'); window.location.reload(); };
    const message = (event: MessageEvent) => { if (event.data === 'reload') window.location.reload(); };
    navigator.serviceWorker?.addEventListener('controllerchange', controllerChanged);
    channel?.addEventListener('message', message);
    return () => { navigator.serviceWorker?.removeEventListener('controllerchange', controllerChanged); channel?.close(); };
  }, []);
  const activateUpdate = useCallback(() => {
    if (!isReloadSafe) return false;
    window.dispatchEvent(new CustomEvent('cloudcli:flush-durable-state'));
    window.setTimeout(() => activateWaitingServiceWorker(), 0);
    return true;
  }, [isReloadSafe]);
  const postponeUpdate = useCallback(() => setUpdateReady(false), []);
  const value = useMemo(() => ({ updateReady, activateUpdate, postponeUpdate, checkForUpdate: checkForPwaUpdate }), [activateUpdate, postponeUpdate, updateReady]);
  return <PwaUpdateContext.Provider value={value}>{children}</PwaUpdateContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePwaUpdate() {
  const value = useContext(PwaUpdateContext);
  if (!value) throw new Error('usePwaUpdate must be used within PwaUpdateProvider');
  return value;
}
