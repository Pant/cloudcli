import assert from 'node:assert/strict';
import test from 'node:test';

import { clearDiagnostics, diagnosticLimits, exportDiagnostics, incrementDiagnosticMetric, logDiagnostic, readDiagnosticMetrics } from './logger';

test('redacts sensitive keys and bearer/JWT-like strings', () => {
  clearDiagnostics();
  logDiagnostic({ level: 'info', area: 'test', event: 'redaction', metadata: { token: 'secret', prompt: 'hello', content: 'message', body: { safe: false }, files: ['private.txt'], credentials: { username: 'u' }, safe: 'Bearer abc.def.ghi', nested: { password: 'pw' } } });
  const bundle = JSON.parse(exportDiagnostics());
  assert.equal(bundle.events[0].metadata.token, '[REDACTED]');
  assert.equal(bundle.events[0].metadata.prompt, '[REDACTED]');
  assert.equal(bundle.events[0].metadata.content, '[REDACTED]');
  assert.equal(bundle.events[0].metadata.body, '[REDACTED]');
  assert.equal(bundle.events[0].metadata.files, '[REDACTED]');
  assert.equal(bundle.events[0].metadata.credentials, '[REDACTED]');
  assert.equal(bundle.events[0].metadata.safe, '[REDACTED]');
  assert.equal(bundle.events[0].metadata.nested.password, '[REDACTED]');
});

test('diagnostic collection and export never throw on hostile values', () => {
  clearDiagnostics();
  const hostile = Object.create(null, {
    safe: { enumerable: true, get() { throw new Error('getter failure'); } },
  });
  assert.doesNotThrow(() => logDiagnostic({ level: 'info', area: 'test', event: 'hostile', metadata: hostile }));
  assert.doesNotThrow(() => exportDiagnostics());
});

test('bounds events and strings', () => {
  clearDiagnostics();
  for (let index = 0; index < diagnosticLimits.maxEvents + 10; index += 1) logDiagnostic({ level: 'debug', area: 'test', event: String(index), metadata: { safe: 'x'.repeat(1000) } });
  const bundle = JSON.parse(exportDiagnostics());
  assert.equal(bundle.events.length, diagnosticLimits.maxEvents);
  assert.equal(bundle.events[0].event, '10');
  assert.equal(bundle.events[0].metadata.safe.length, diagnosticLimits.maxStringLength);
});

test('tracks metrics and exports app metadata', () => {
  clearDiagnostics();
  incrementDiagnosticMetric('websocketReconnect');
  incrementDiagnosticMetric('hydrationDuration', 42);
  assert.equal(readDiagnosticMetrics().websocketReconnect, 1);
  const bundle = JSON.parse(exportDiagnostics());
  assert.equal(bundle.metrics.hydrationDuration, 42);
  assert.match(bundle.app.version, /^\d+\./);
});
