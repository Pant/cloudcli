import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceUrl = new URL('./DocsUiPanel.tsx', import.meta.url);

test('Docs iframe uses only the protected same-origin proxy with a constrained sandbox', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  assert.match(source, /src="\/api\/docs-ui\/"/);
  assert.match(source, /sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin allow-downloads"/);
  assert.doesNotMatch(source, /docs-mcp-proxy|docs\.code|Authorization|Basic /i);
  assert.doesNotMatch(source, /allow-top-navigation/);
});

test('Docs panel provides a refresh button before the iframe', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  const refreshButton = source.indexOf('aria-label="Refresh Docs"');
  const iframe = source.indexOf('<iframe');

  assert.notEqual(refreshButton, -1);
  assert.ok(refreshButton < iframe);
  assert.match(source, /setIframeKey\(\(currentKey\) => currentKey \+ 1\)/);
  assert.match(source, /key=\{iframeKey\}/);
});

test('Docs panel automatically remounts an iframe whose application root stays empty', async () => {
  const source = await readFile(sourceUrl, 'utf8');

  assert.match(source, /contentDocument\?\.getElementById\('root'\)/);
  assert.match(source, /visibleTextLength > 0/);
  assert.match(source, /rootRectangle\.width > 0/);
  assert.match(source, /rootRectangle\.height > 0/);
  assert.match(source, /recoveryAttemptedRef\.current = true/);
  assert.match(source, /onLoad=\{handleIframeLoad\}/);
  assert.match(source, /DOCS_RENDER_TIMEOUT_MS = 3_000/);
});

test('Docs panel emits safe lifecycle and render-recovery diagnostics', async () => {
  const source = await readFile(sourceUrl, 'utf8');

  assert.match(source, /area: 'docs_ui'/);
  assert.match(source, /event: 'session_initialization_started'/);
  assert.match(source, /event: 'iframe_loaded'/);
  assert.match(source, /event: 'iframe_render_confirmed'/);
  assert.match(source, /event: 'iframe_render_recovery_started'/);
  assert.match(source, /event: 'iframe_render_recovery_failed'/);
  assert.match(source, /event: 'iframe_render_check_skipped'/);
  assert.match(source, /event: 'manual_refresh_requested'/);
  assert.doesNotMatch(source, /Authorization|cookie|token|password|credential/i);
});
