import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceUrl = new URL('./MainContentHeader.tsx', import.meta.url);
const mainContentSourceUrl = new URL('../MainContent.tsx', import.meta.url);

test('soft reload trigger is immediately before the tab wrapper and leaves right-side controls intact', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  const softReloadButton = source.indexOf('onClick={onSoftReload}');
  const tabSwitcher = source.indexOf('<MainContentTabSwitcher');
  const consoleButton = source.indexOf('onClick={() => setIsConsoleOpen(true)}');
  const hardReloadButton = source.indexOf('onClick={() => window.location.reload()}');

  assert.ok(softReloadButton >= 0 && softReloadButton < tabSwitcher);
  assert.ok(tabSwitcher < consoleButton && consoleButton < hardReloadButton);
  assert.match(source.slice(softReloadButton, tabSwitcher), /aria-label="Soft reload current tab"/);
  assert.match(source.slice(softReloadButton, tabSwitcher), /title="Soft reload current tab"/);
  assert.doesNotMatch(source.slice(softReloadButton, tabSwitcher), /window\.location\.reload/);
});

test('soft reload increments only the active tab generation and keys every panel boundary', async () => {
  const source = await readFile(mainContentSourceUrl, 'utf8');

  assert.match(source, /setTabGenerations\(\(generations\) => \(\{\s*\.\.\.generations,\s*\[activeTab\]: \(generations\[activeTab\] \?\? 0\) \+ 1/);
  assert.match(source, /onSoftReload=\{handleSoftReload\}/);
  for (const tab of ['chat', 'files', 'shell', 'git', 'browser', 'docs']) {
    assert.match(source, new RegExp(`key=\\{\\\`${tab}-\\$\\{tabGenerations\\.${tab} \\?\\? 0\\}\\\`\\}`));
  }
  assert.match(source, /key=\{`\$\{activeTab\}-\$\{tabGenerations\[activeTab\] \?\? 0\}`\}/);
  assert.doesNotMatch(source, /window\.location\.reload/);
});

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
