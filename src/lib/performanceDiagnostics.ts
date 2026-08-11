import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

import { logPerformanceDiagnostic } from './logger';

export type CloudCliLifecycleName = 'auth-ready' | 'protected-shell-ready' | 'app-shell-ready' | 'surface-ready';

let initialized = false;
const emittedLifecycle = new Set<string>();

export function normalizePerformanceRoute(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  if (/\/session\/[^/]+$/.test(path)) return '/session/:sessionId';
  if (/\/project\/[^/]+\/new$/.test(path)) return '/project/:projectId/new';
  return path === '/' ? '/' : '/other';
}

export function normalizeSurface(surface: string): string {
  if (surface.startsWith('plugin:')) return 'plugin';
  return ['chat', 'files', 'shell', 'git', 'browser', 'docs'].includes(surface) ? surface : 'other';
}

function context() {
  let displayMode: 'browser' | 'standalone' | 'minimal-ui' | 'fullscreen' | 'window-controls-overlay' | 'unknown' = 'browser';
  try {
    if (window.matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && navigator.standalone === true)) displayMode = 'standalone';
    else if (window.matchMedia('(display-mode: minimal-ui)').matches) displayMode = 'minimal-ui';
    else if (window.matchMedia('(display-mode: fullscreen)').matches) displayMode = 'fullscreen';
    else if (window.matchMedia('(display-mode: window-controls-overlay)').matches) displayMode = 'window-controls-overlay';
  } catch { displayMode = 'unknown'; }
  let navigationType: 'navigate' | 'reload' | 'back_forward' | 'prerender' | 'unknown' = 'unknown';
  try {
    const type = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (type && ['navigate', 'reload', 'back_forward', 'prerender'].includes(type.type)) navigationType = type.type;
  } catch { /* unsupported */ }
  return { route: normalizePerformanceRoute(window.location.pathname), displayMode, navigationType, buildId: __CLOUDCLI_CLIENT_BUILD_ID__ };
}

function recordMetric(metric: Metric): void {
  try { logPerformanceDiagnostic({ name: metric.name, value: metric.value, rating: metric.rating, ...context() }); } catch { /* diagnostics are fail-open */ }
}

export function initializePerformanceDiagnostics(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  try { onCLS(recordMetric); } catch { /* unsupported */ }
  try { onFCP(recordMetric); } catch { /* unsupported */ }
  try { onINP(recordMetric); } catch { /* unsupported */ }
  try { onLCP(recordMetric); } catch { /* unsupported */ }
  try { onTTFB(recordMetric); } catch { /* unsupported */ }
}

export function markCloudCliLifecycle(name: CloudCliLifecycleName, detail?: string): void {
  try {
    const normalizedDetail = detail ? normalizeSurface(detail) : '';
    const key = `${name}:${normalizedDetail}`;
    if (emittedLifecycle.has(key)) return;
    emittedLifecycle.add(key);
    const markName = `cloudcli:${key}`;
    performance.mark(markName);
    const start = performance.timeOrigin;
    const entry = performance.getEntriesByName(markName).at(-1);
    logPerformanceDiagnostic({ name: key, value: Math.max(0, entry ? entry.startTime : performance.now() - start), ...context() });
  } catch { /* unsupported */ }
}

export function resetPerformanceDiagnosticsForTests(): void {
  initialized = false;
  emittedLifecycle.clear();
}
