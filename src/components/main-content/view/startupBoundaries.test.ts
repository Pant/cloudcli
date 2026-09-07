import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainContentUrl = new URL('./MainContent.tsx', import.meta.url);
const tabSwitcherUrl = new URL('./subcomponents/MainContentTabSwitcher.tsx', import.meta.url);
const appUrl = new URL('../../../App.tsx', import.meta.url);
const pluginsUrl = new URL('../../../contexts/PluginsContext.tsx', import.meta.url);
const quickSettingsUrl = new URL('../../quick-settings-panel/view/QuickSettingsPanelTrigger.tsx', import.meta.url);
const settingsUrl = new URL('../../settings/view/Settings.tsx', import.meta.url);

test('every persisted non-chat tab starts without importing or mounting chat', async () => {
  const source = await readFile(mainContentUrl, 'utf8');

  assert.match(source, /const ChatInterface = lazy\(\(\) => import\('\.\.\/\.\.\/chat\/view\/ChatInterface'\)\)/);
  assert.doesNotMatch(source, /import ChatInterface from/);
  assert.match(source, /useState\(\(\) => activeTab === 'chat' \|\| Boolean\(selectedSession\)\)/);
  assert.match(source, /\{chatInvoked && <div key=\{`chat-/);
  for (const tab of ['files', 'shell', 'git', 'docs', 'browser', 'plugin:']) {
    assert.ok(!(`'${tab}'` === "'chat'"), `${tab} must remain a non-chat startup intent`);
  }
});

test('direct chat and session intent mount chat and preserve it after later tab changes', async () => {
  const source = await readFile(mainContentUrl, 'utf8');

  assert.match(source, /activeTab === 'chat' \|\| Boolean\(selectedSession\)/);
  assert.match(source, /if \(activeTab === 'chat' \|\| selectedSession\) setChatInvoked\(true\)/);
  assert.doesNotMatch(source, /setChatInvoked\(false\)/);
  assert.match(source, /activeTab === 'chat' \? 'block' : 'hidden'/);
  assert.match(source, /isActive=\{activeTab === 'chat'\}/);
  assert.match(source, /if \(chatInvoked\) namespaces\.push\('chat'\)/);
});

test('plugin metadata is gated by protected entry and concurrent reads share one owner', async () => {
  const [app, plugins] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(pluginsUrl, 'utf8'),
  ]);
  const protectedStart = app.indexOf('<ProtectedRoute>');
  const providerStart = app.indexOf('<PluginsProvider>');
  const providerEnd = app.indexOf('</PluginsProvider>');
  const protectedEnd = app.indexOf('</ProtectedRoute>');

  assert.ok(protectedStart < providerStart && providerStart < providerEnd && providerEnd < protectedEnd);
  assert.match(plugins, /let sharedPluginsOwner: KeyedServerState<'plugins', Plugin\[]> \| null = null/);
  assert.match(plugins, /sharedPluginsOwner \?\?= new KeyedServerState/);
  assert.match(plugins, /ownerRef\.current = getPluginsOwner\(\)/);
  assert.equal((plugins.match(/authenticatedFetch\('\/api\/plugins'/g) || []).length, 1);
});

test('surface, quick-settings, and settings warmups reuse stable promises', async () => {
  const [tabs, quickSettings, settings] = await Promise.all([
    readFile(tabSwitcherUrl, 'utf8'),
    readFile(quickSettingsUrl, 'utf8'),
    readFile(settingsUrl, 'utf8'),
  ]);

  assert.match(tabs, /const featureWarmPromises = new Map<AppTab, Promise<unknown>>\(\)/);
  assert.match(tabs, /const existing = featureWarmPromises\.get\(tab\);\s*if \(existing\) return existing/);
  assert.match(tabs, /onPointerEnter=.*warmMainContentFeature/);
  assert.match(tabs, /onFocus=.*warmMainContentFeature/);
  assert.match(tabs, /onClick=.*warmMainContentFeature.*setActiveTab/s);
  assert.match(tabs, /if \(!loader\) return undefined/);

  assert.match(quickSettings, /quickSettingsWarmPromise \?\?= import\('\.\/QuickSettingsPanelView'\)/);
  assert.match(quickSettings, /onWarm=\{warmQuickSettingsPanel\}/);
  assert.match(quickSettings, /const QuickSettingsPanelView = lazy\(warmQuickSettingsPanel\)/);

  assert.match(settings, /const settingsWarmPromises = new Map<SettingsMainTab, Promise<unknown>>\(\)/);
  assert.match(settings, /const existing = settingsWarmPromises\.get\(tab\);\s*if \(existing\) return existing/);
  assert.match(settings, /onChange=\{\(tab\) => \{ void warmSettingsTab\(tab\); setActiveTab\(tab\); \}\}/);
});
