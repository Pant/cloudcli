import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { authenticatedFetch } from '../utils/api';
import { KeyedServerState } from '../lib/serverState';

import { PluginsContext } from './plugins';
import type { Plugin } from './plugins';

export type { Plugin } from './plugins';

export function PluginsProvider({ children }: { children: ReactNode }) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const ownerRef = useRef<KeyedServerState<'plugins', Plugin[]> | null>(null);
  if (!ownerRef.current) {
    ownerRef.current = new KeyedServerState(async (_key, signal) => {
      const res = await authenticatedFetch('/api/plugins', { signal });
      if (!res.ok) {
        let errorMessage = `Failed to fetch plugins (${res.status})`;
        try {
          const data = await res.json();
          errorMessage = data.details || data.error || errorMessage;
        } catch { errorMessage = res.statusText || errorMessage; }
        throw new Error(errorMessage);
      }
      const data = await res.json();
      return data.plugins || [];
    }, 5_000);
  }

  const refreshPlugins = useCallback(async () => {
    try {
      const data = await ownerRef.current!.read('plugins');
      setPlugins(data);
      setPluginsError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch plugins';
      setPluginsError(message);
      console.error('[Plugins] Failed to fetch plugins:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshPlugins();
    return () => ownerRef.current?.dispose();
  }, [refreshPlugins]);

  const refreshAfterMutation = useCallback(async () => {
    ownerRef.current?.invalidate('plugins');
    const data = await ownerRef.current!.read('plugins', { force: true });
    setPlugins(data);
    setPluginsError(null);
  }, []);

  const installPlugin = useCallback(async (url: string) => {
    try {
      const res = await authenticatedFetch('/api/plugins/install', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (res.ok) {
        await refreshAfterMutation();
        return { success: true };
      }
      return { success: false, error: data.details || data.error || 'Install failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Install failed' };
    }
  }, [refreshAfterMutation]);

  const uninstallPlugin = useCallback(async (name: string) => {
    try {
      const res = await authenticatedFetch(`/api/plugins/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (res.ok) {
        await refreshAfterMutation();
        return { success: true };
      }
      return { success: false, error: data.details || data.error || 'Uninstall failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Uninstall failed' };
    }
  }, [refreshAfterMutation]);

  const updatePlugin = useCallback(async (name: string) => {
    try {
      const res = await authenticatedFetch(`/api/plugins/${encodeURIComponent(name)}/update`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        await refreshAfterMutation();
        return { success: true };
      }
      return { success: false, error: data.details || data.error || 'Update failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Update failed' };
    }
  }, [refreshAfterMutation]);

  const togglePlugin = useCallback(async (name: string, enabled: boolean): Promise<{ success: boolean; error: string | null }> => {
    try {
      const res = await authenticatedFetch(`/api/plugins/${encodeURIComponent(name)}/enable`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        let errorMessage = `Toggle failed (${res.status})`;
        try {
          const data = await res.json();
          errorMessage = data.details || data.error || errorMessage;
        } catch {
          // response body wasn't JSON, use status text
          errorMessage = res.statusText || errorMessage;
        }
        return { success: false, error: errorMessage };
      }
      await refreshAfterMutation();
      return { success: true, error: null };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Toggle failed' };
    }
  }, [refreshAfterMutation]);

  return (
    <PluginsContext.Provider value={{ plugins, loading, pluginsError, refreshPlugins, installPlugin, uninstallPlugin, updatePlugin, togglePlugin }}>
      {children}
    </PluginsContext.Provider>
  );
}
