import assert from 'node:assert/strict';
import test from 'node:test';

import { clearDiagnostics, exportDiagnostics } from './logger';
import { createPerformanceProfiler, initializePerformanceDiagnostics, markCloudCliLifecycle, normalizePerformanceRoute, normalizeSurface, resetPerformanceDiagnosticsForTests } from './performanceDiagnostics';

test('normalizes routes and surfaces without identifiers', () => {
  assert.equal(normalizePerformanceRoute('/session/private-id?token=x'), '/session/:sessionId');
  assert.equal(normalizePerformanceRoute('/project/private/new'), '/project/:projectId/new');
  assert.equal(normalizePerformanceRoute('/unexpected/private'), '/other');
  assert.equal(normalizeSurface('plugin:private-name'), 'plugin');
});

test('initialization and lifecycle metrics are duplicate-safe and privacy-safe', () => {
  clearDiagnostics();
  resetPerformanceDiagnosticsForTests();
  assert.doesNotThrow(() => initializePerformanceDiagnostics());
  assert.doesNotThrow(() => initializePerformanceDiagnostics());
  assert.doesNotThrow(() => markCloudCliLifecycle('surface-ready', 'plugin:secret-plugin'));
  assert.doesNotThrow(() => markCloudCliLifecycle('surface-ready', 'plugin:secret-plugin'));
  const bundle = JSON.parse(exportDiagnostics());
  const samples = bundle.events.filter((event: { area: string }) => event.area === 'performance');
  assert.ok(samples.length <= 1);
  if (samples[0]) {
    assert.equal(samples[0].metadata.detail, undefined);
    assert.equal(samples[0].metadata.name, 'surface-ready:plugin');
    assert.equal(JSON.stringify(samples[0]).includes('secret-plugin'), false);
  }
});

test('bounded capture returns one deterministic privacy-safe report and shares concurrent requests', async () => {
  const logged: string[] = [];
  let observerCleanups = 0;
  const profiler = createPerformanceProfiler({
    durationMs: 100,
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    observeLongTasks: (callback) => { callback(350); return () => { observerCleanups += 1; }; },
    route: () => '/session/private-id?token=secret',
    displayMode: () => 'browser',
    visibility: () => 'visible',
    hardwareConcurrency: 8,
    deviceMemory: 4,
    connection: '4g',
    memory: () => ({ usedJSHeapSize: 90, jsHeapSizeLimit: 100 }),
    domNodes: () => 6000,
    resources: () => ({ count: 12, transferBytes: 1234 }),
    activeAnimations: () => 2,
    consoleInfo: (report) => logged.push(report),
  });
  const first = profiler.capture();
  const second = profiler.capture();
  assert.equal(first, second);
  const report = await first;
  assert.equal(logged.length, 1);
  assert.equal(logged[0], report);
  assert.equal(observerCleanups, 1);
  assert.ok(report.startsWith('CLOUDCLI_CLIENT_PERFORMANCE_REPORT_BEGIN\n'));
  assert.ok(report.endsWith('\nCLOUDCLI_CLIENT_PERFORMANCE_REPORT_END'));
  assert.equal(report.includes('private-id'), false);
  assert.equal(report.includes('token=secret'), false);
  const payload = JSON.parse(report.split('\n').slice(1, -1).join('\n'));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.indicators.length, 30);
  assert.deepEqual(new Set(payload.indicators.map((item: { name: string }) => item.name)).size, 30);
  assert.ok(payload.indicators.some((item: { kind: string }) => item.kind === 'unsupported'));
  assert.ok(payload.indicators.some((item: { kind: string }) => item.kind === 'proxy'));
  assert.ok(payload.indicators.some((item: { kind: string }) => item.kind === 'privacy-reduced'));
  assert.ok(payload.interpretation.some((message: string) => message.includes('CPU/main-thread')));
  assert.ok(payload.interpretation.some((message: string) => message.includes('memory pressure')));
  assert.ok(payload.limitations.every((message: string) => !message.includes('utilization percentage')));
});
