import assert from 'node:assert/strict';
import test from 'node:test';

import { clearDiagnostics, exportDiagnostics } from './logger';
import { initializePerformanceDiagnostics, markCloudCliLifecycle, normalizePerformanceRoute, normalizeSurface, resetPerformanceDiagnosticsForTests } from './performanceDiagnostics';

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
