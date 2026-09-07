import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

import { logPerformanceDiagnostic } from './logger';

export type CloudCliLifecycleName = 'auth-ready' | 'protected-shell-ready' | 'app-shell-ready' | 'surface-ready';
export type PerformanceIndicatorKind = 'measured' | 'estimate' | 'proxy' | 'unsupported' | 'privacy-reduced';
export type PerformanceIndicator = { name: string; kind: PerformanceIndicatorKind; value: number | string | boolean | null; unit?: string };
export type ClientPerformanceReport = { schemaVersion: 1; indicators: PerformanceIndicator[]; interpretation: string[]; limitations: string[] };

type MetricEvidence = { value: number; rating?: string };
type PerformanceMemory = { usedJSHeapSize: number; jsHeapSizeLimit: number };
type BatteryLike = { level: number; charging: boolean };
type WebGlFacts = { availability: string; version: string; vendor: string; renderer: string; contextLost: boolean | null; maxTextureSize: number | null; maxRenderbufferSize: number | null; maxViewportDimension: number | null; cleanup?: () => void };

export type PerformanceProfilerEnvironment = {
  durationMs?: number;
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  requestAnimationFrame?: (callback: (timestamp: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  observeLongTasks?: (callback: (duration: number) => void) => () => void;
  route: () => string;
  displayMode: () => string;
  visibility: () => string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  connection?: string;
  battery?: () => Promise<BatteryLike>;
  memory?: () => PerformanceMemory | undefined;
  domNodes?: () => number;
  resources?: () => { count: number; transferBytes: number };
  activeAnimations?: () => number;
  webGl?: () => WebGlFacts;
  consoleInfo: (report: string) => void;
};

const REPORT_BEGIN = 'CLOUDCLI_CLIENT_PERFORMANCE_REPORT_BEGIN';
const REPORT_END = 'CLOUDCLI_CLIENT_PERFORMANCE_REPORT_END';
const retainedMetrics = new Map<string, MetricEvidence>();
const retainedLifecycle = new Map<string, number>();
let initialized = false;
let latestReport: string | null = null;
let activeCapture: Promise<string> | null = null;
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
  retainedMetrics.set(metric.name, { value: metric.value, rating: metric.rating });
  try { logPerformanceDiagnostic({ name: metric.name, value: metric.value, rating: metric.rating, ...context() }); } catch { /* diagnostics are fail-open */ }
}

function unsupported(name: string): PerformanceIndicator { return { name, kind: 'unsupported', value: null }; }
function numeric(name: string, value: number | undefined, kind: PerformanceIndicatorKind, unit?: string): PerformanceIndicator {
  return value === undefined || !Number.isFinite(value) ? unsupported(name) : { name, kind, value: Math.round(value * 100) / 100, ...(unit ? { unit } : {}) };
}

export function formatClientPerformanceReport(payload: ClientPerformanceReport): string {
  return `${REPORT_BEGIN}\n${JSON.stringify(payload, null, 2)}\n${REPORT_END}`;
}

function interpret(indicators: PerformanceIndicator[]): string[] {
  const value = (name: string) => indicators.find((item) => item.name === name)?.value;
  const messages: string[] = [];
  if ((Number(value('mainThread.longTaskTotalMs')) >= 300) || (Number(value('mainThread.eventLoopDelayP95Ms')) >= 100)) messages.push('Strong CPU/main-thread pressure proxy: long tasks or event-loop delay were high; this is not system CPU utilization.');
  if ((Number(value('frames.slowFrameRatio')) >= 0.2) || (Number(value('frames.estimatedFps')) > 0 && Number(value('frames.estimatedFps')) < 45)) messages.push('Strong render/frame pressure proxy: frame cadence was degraded; WebGL facts do not measure GPU utilization.');
  const used = Number(value('memory.jsHeapUsedBytes')); const limit = Number(value('memory.jsHeapLimitBytes'));
  if ((limit > 0 && used / limit >= 0.8) || Number(value('dom.nodeCount')) >= 5000) messages.push('Strong memory pressure evidence: observed heap ratio or DOM size was high.');
  return messages.length ? messages : ['No strong bottleneck class was identified during this bounded sample.'];
}

export function createPerformanceProfiler(environment: PerformanceProfilerEnvironment) {
  let running: Promise<string> | null = null;
  const capture = (): Promise<string> => {
    if (running) return running;
    running = (async () => {
      const duration = Math.max(100, environment.durationMs ?? 3000);
      const started = environment.now();
      const frameTimes: number[] = [];
      const delays: number[] = [];
      const longTasks: number[] = [];
      let frameHandle: number | undefined;
      let probeHandle: unknown;
      let stopLongTasks: (() => void) | undefined;
      let webGlCleanup: (() => void) | undefined;
      let stopped = false;
      const probe = () => {
        const expected = environment.now() + 50;
        probeHandle = environment.setTimeout(() => { delays.push(Math.max(0, environment.now() - expected)); if (!stopped) probe(); }, 50);
      };
      if (environment.requestAnimationFrame) {
        const frame = (timestamp: number) => { frameTimes.push(timestamp); if (!stopped) frameHandle = environment.requestAnimationFrame?.(frame); };
        frameHandle = environment.requestAnimationFrame(frame);
      }
      try { stopLongTasks = environment.observeLongTasks?.((value) => longTasks.push(value)); } catch { /* unsupported */ }
      probe();
      try {
        await new Promise<void>((resolve) => environment.setTimeout(resolve, duration));
        stopped = true;
        const elapsed = Math.max(1, environment.now() - started);
        const intervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index]);
        const slowFrames = intervals.filter((value) => value > 20).length;
        const sortedDelays = [...delays].sort((a, b) => a - b);
        const memory = environment.memory?.();
        const resources = environment.resources?.();
        let battery: BatteryLike | undefined;
        try { battery = await environment.battery?.(); } catch { /* unsupported */ }
        let gl: WebGlFacts | undefined;
        try { gl = environment.webGl?.(); webGlCleanup = gl?.cleanup; } catch { /* unsupported */ }
        const metricSummary = [...retainedMetrics.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, metric]) => `${name}:${Math.round(metric.value * 100) / 100}:${metric.rating ?? 'unrated'}`).join(',') || 'none';
        const lifecycleSummary = [...retainedLifecycle.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}:${Math.round(value)}`).join(',') || 'none';
        const indicators: PerformanceIndicator[] = [
          numeric('capture.durationMs', elapsed, 'measured', 'ms'),
          { name: 'environment.route', kind: 'measured', value: normalizePerformanceRoute(environment.route()) },
          { name: 'environment.displayMode', kind: 'measured', value: environment.displayMode() },
          { name: 'environment.visibility', kind: 'measured', value: environment.visibility() },
          numeric('environment.logicalCpuCount', environment.hardwareConcurrency, 'privacy-reduced'),
          numeric('environment.deviceMemoryGiB', environment.deviceMemory, 'privacy-reduced', 'GiB'),
          environment.connection ? { name: 'environment.connectionHint', kind: 'privacy-reduced', value: environment.connection } : unsupported('environment.connectionHint'),
          numeric('mainThread.eventLoopDelayP95Ms', sortedDelays[Math.max(0, Math.ceil(sortedDelays.length * 0.95) - 1)], 'proxy', 'ms'),
          numeric('mainThread.longTaskCount', environment.observeLongTasks ? longTasks.length : undefined, 'measured'),
          numeric('mainThread.longTaskTotalMs', environment.observeLongTasks ? longTasks.reduce((sum, value) => sum + value, 0) : undefined, 'measured', 'ms'),
          numeric('mainThread.longTaskMaxMs', environment.observeLongTasks ? Math.max(0, ...longTasks) : undefined, 'measured', 'ms'),
          numeric('frames.frameCount', environment.requestAnimationFrame ? frameTimes.length : undefined, 'measured'),
          numeric('frames.estimatedFps', environment.requestAnimationFrame ? frameTimes.length * 1000 / elapsed : undefined, 'estimate', 'fps'),
          numeric('frames.slowFrameCount', environment.requestAnimationFrame ? slowFrames : undefined, 'proxy'),
          numeric('frames.slowFrameRatio', environment.requestAnimationFrame && intervals.length ? slowFrames / intervals.length : undefined, 'proxy'),
          { name: 'gpu.contextAvailability', kind: gl ? 'measured' : 'unsupported', value: gl?.availability ?? null },
          { name: 'gpu.webGlVersion', kind: gl ? 'measured' : 'unsupported', value: gl?.version ?? null },
          { name: 'gpu.vendor', kind: gl ? 'privacy-reduced' : 'unsupported', value: gl?.vendor ?? null },
          { name: 'gpu.renderer', kind: gl ? 'privacy-reduced' : 'unsupported', value: gl?.renderer ?? null },
          { name: 'gpu.contextLost', kind: gl ? 'measured' : 'unsupported', value: gl?.contextLost ?? null },
          numeric('gpu.maxTextureSize', gl?.maxTextureSize ?? undefined, gl ? 'measured' : 'unsupported'),
          numeric('memory.jsHeapUsedBytes', memory?.usedJSHeapSize, 'measured', 'bytes'),
          numeric('memory.jsHeapLimitBytes', memory?.jsHeapSizeLimit, 'privacy-reduced', 'bytes'),
          numeric('dom.nodeCount', environment.domNodes?.(), 'measured'),
          numeric('resources.entryCount', resources?.count, 'measured'),
          numeric('resources.transferBytes', resources?.transferBytes, 'measured', 'bytes'),
          numeric('render.activeAnimationCount', environment.activeAnimations?.(), 'measured'),
          battery ? { name: 'environment.batteryState', kind: 'privacy-reduced', value: `${Math.round(battery.level * 100)}%:${battery.charging ? 'charging' : 'discharging'}` } : unsupported('environment.batteryState'),
          { name: 'evidence.webVitals', kind: retainedMetrics.size ? 'measured' : 'unsupported', value: metricSummary },
          { name: 'evidence.lifecycleMilestones', kind: retainedLifecycle.size ? 'measured' : 'unsupported', value: lifecycleSummary },
        ];
        const payload: ClientPerformanceReport = { schemaVersion: 1, indicators, interpretation: interpret(indicators), limitations: ['Browser JavaScript cannot measure authoritative system CPU or GPU utilization.', 'Hardware, memory, battery, connection, and WebGL facts may be unavailable or privacy-reduced.'] };
        const report = formatClientPerformanceReport(payload);
        environment.consoleInfo(report);
        return report;
      } finally {
        stopped = true;
        if (probeHandle !== undefined) environment.clearTimeout(probeHandle);
        if (frameHandle !== undefined) environment.cancelAnimationFrame?.(frameHandle);
        stopLongTasks?.();
        webGlCleanup?.();
      }
    })().finally(() => { running = null; });
    return running;
  };
  return { capture, get latestReport() { return latestReport; } };
}

function browserEnvironment(): PerformanceProfilerEnvironment {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string }; getBattery?: () => Promise<BatteryLike> };
  return {
    now: () => performance.now(), setTimeout: (callback, delay) => window.setTimeout(callback, delay), clearTimeout: (handle) => window.clearTimeout(handle as number),
    requestAnimationFrame: window.requestAnimationFrame?.bind(window), cancelAnimationFrame: window.cancelAnimationFrame?.bind(window),
    observeLongTasks: typeof PerformanceObserver === 'undefined' ? undefined : (callback) => { const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => callback(entry.duration))); observer.observe({ entryTypes: ['longtask'] }); return () => observer.disconnect(); },
    route: () => window.location.pathname, displayMode: () => context().displayMode, visibility: () => document.visibilityState,
    hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory, connection: nav.connection?.effectiveType,
    battery: nav.getBattery?.bind(nav), memory: () => (performance as Performance & { memory?: PerformanceMemory }).memory,
    domNodes: () => document.getElementsByTagName('*').length,
    resources: () => { const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]; return { count: entries.length, transferBytes: entries.reduce((sum, entry) => sum + (entry.transferSize || 0), 0) }; },
    activeAnimations: () => document.getAnimations?.().length ?? 0,
    webGl: () => readWebGlFacts(), consoleInfo: (report) => console.info(report),
  };
}

function readWebGlFacts(): WebGlFacts {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) return { availability: 'unavailable', version: 'none', vendor: 'unavailable', renderer: 'unavailable', contextLost: null, maxTextureSize: null, maxRenderbufferSize: null, maxViewportDimension: null };
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[];
  return { availability: 'available', version: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1', vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : 'privacy-reduced', renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'privacy-reduced', contextLost: gl.isContextLost(), maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)), maxRenderbufferSize: Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)), maxViewportDimension: Math.max(...viewport), cleanup: () => gl.getExtension('WEBGL_lose_context')?.loseContext() };
}

export function captureClientPerformance(): Promise<string> {
  if (activeCapture) return activeCapture;
  activeCapture = createPerformanceProfiler(browserEnvironment()).capture().then((report) => { latestReport = report; return report; }).finally(() => { activeCapture = null; });
  return activeCapture;
}

export function getLatestClientPerformanceReport(): string | null { return latestReport; }

export function initializePerformanceDiagnostics(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  window.cloudcliPerformance = { capture: captureClientPerformance, get latestReport() { return getLatestClientPerformanceReport(); } };
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
    const value = Math.max(0, entry ? entry.startTime : performance.now() - start);
    retainedLifecycle.set(key, value);
    logPerformanceDiagnostic({ name: key, value, ...context() });
  } catch { /* unsupported */ }
}

export function resetPerformanceDiagnosticsForTests(): void {
  initialized = false; latestReport = null; activeCapture = null; emittedLifecycle.clear(); retainedMetrics.clear(); retainedLifecycle.clear();
}
