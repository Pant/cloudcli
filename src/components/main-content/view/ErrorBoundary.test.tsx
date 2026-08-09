import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { RecoveryFallback } from './ErrorBoundary';
import { createDiagnosticId } from './errorBoundary.utils';

test('feature fallback is accessible and exposes a diagnostic id with scoped retry', () => {
  const html = renderToStaticMarkup(<RecoveryFallback error={new Error('private prompt')} resetErrorBoundary={() => undefined} name="File tree" diagnosticId="diag-safe" componentStack={null} retryLabel="Retry files" />);
  assert.match(html, /role="alert"/);
  assert.match(html, /File tree is unavailable/);
  assert.match(html, /Diagnostic ID: diag-safe/);
  assert.match(html, /Retry files/);
  assert.doesNotMatch(html, /private prompt/);
});

test('diagnostic ids are non-empty and distinct', () => {
  assert.notEqual(createDiagnosticId(), createDiagnosticId());
});

test('root fallback exposes startup details needed for production recovery', () => {
  const html = renderToStaticMarkup(<RecoveryFallback error={new Error('startup exploded')} resetErrorBoundary={() => undefined} name="Application" diagnosticId="diag-root" componentStack={'\n    at App'} retryLabel="Reload CloudCLI" root showDetails />);
  assert.match(html, /Error details/);
  assert.match(html, /Error: startup exploded/);
  assert.match(html, /at App/);
});
