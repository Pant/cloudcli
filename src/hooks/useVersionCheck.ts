import { useEffect, useSyncExternalStore } from 'react';

import { version } from '../../package.json';
import type { ReleaseInfo } from '../types/sharedTypes';

const compareVersions = (v1: string, v2: string) => {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let index = 0; index < Math.max(parts1.length, parts2.length); index += 1) {
    const difference = (parts1[index] || 0) - (parts2[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export type InstallMode = 'git' | 'npm';
type VersionState = {
  updateAvailable: boolean;
  latestVersion: string | null;
  releaseInfo: ReleaseInfo | null;
  installMode: InstallMode;
  runningVersion: string | null;
  restartRequired: boolean;
};

const initialState: VersionState = { updateAvailable: false, latestVersion: null, releaseInfo: null, installMode: 'git', runningVersion: null, restartRequired: false };
let state = initialState;
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const publish = (next: Partial<VersionState>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()); };

const schedule = (owner: string, repo: string, delay: number) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void refresh(owner, repo), delay);
};

const refresh = async (owner: string, repo: string) => {
  if (document.visibilityState === 'hidden' || navigator.onLine === false) {
    schedule(owner, repo, 60_000);
    return;
  }
  try {
    const response = await fetch('/health');
    const data = await response.json();
    const runningVersion = typeof data.version === 'string' && data.version ? data.version : null;
    publish({ installMode: data.installMode === 'npm' ? 'npm' : 'git', runningVersion, restartRequired: runningVersion !== null && runningVersion !== version });
  } catch { /* retain last known health state */ }
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
    const data = await response.json();
    if (data.tag_name) {
      const latestVersion = data.tag_name.replace(/^v/, '');
      publish({
        latestVersion,
        updateAvailable: compareVersions(latestVersion, version) > 0,
        releaseInfo: { title: data.name || data.tag_name, body: data.body || '', htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/releases/latest`, publishedAt: data.published_at },
      });
    }
  } catch { /* external release checks are optional */ }
  schedule(owner, repo, 5 * 60_000);
};

export const useVersionCheck = (owner: string, repo: string) => {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => initialState);
  useEffect(() => {
    if (!started) {
      started = true;
      schedule(owner, repo, 5_000);
    }
    const resume = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) schedule(owner, repo, 0);
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [owner, repo]);
  return { ...snapshot, currentVersion: version };
};
