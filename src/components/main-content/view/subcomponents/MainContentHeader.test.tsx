import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceUrl = new URL('./MainContentHeader.tsx', import.meta.url);

test('console trigger is pinned immediately before the rightmost reload control', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  const tabWrapperEnd = source.indexOf('</div>', source.indexOf('<MainContentTabSwitcher'));
  const consoleButton = source.indexOf('onClick={() => setIsConsoleOpen(true)}');
  const reloadButton = source.indexOf('onClick={() => window.location.reload()}');

  assert.ok(tabWrapperEnd >= 0 && tabWrapperEnd < consoleButton);
  assert.ok(consoleButton < reloadButton);
  assert.match(source.slice(consoleButton, reloadButton), /aria-label=\{consoleLabel\}/);
  assert.match(source.slice(consoleButton, reloadButton), /title=\{consoleLabel\}/);
  assert.match(source.slice(reloadButton), /aria-label="Reload page"/);
});

test('console trigger subscribes to retained messages without rendering a count badge and controls the overlay', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  const consoleButton = source.indexOf('onClick={() => setIsConsoleOpen(true)}');
  const reloadButton = source.indexOf('onClick={() => window.location.reload()}');
  const consoleTrigger = source.slice(consoleButton, reloadButton);

  assert.match(source, /useSyncExternalStore\(\s*subscribeToConsoleMessages,\s*getConsoleMessagesSnapshot,\s*getConsoleMessagesSnapshot/);
  assert.match(source, /Open console messages \(\$\{consoleMessages\.length\} captured\)/);
  assert.doesNotMatch(consoleTrigger, /consoleMessages\.length > 99/);
  assert.doesNotMatch(consoleTrigger, /<span/);
  assert.match(source, /<ConsoleMessagesOverlay open=\{isConsoleOpen\} onOpenChange=\{setIsConsoleOpen\} \/>/);
});
