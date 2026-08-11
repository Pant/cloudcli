import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser settings propagation carries enabled state without a redundant read', async () => {
  const [mainContent, settings] = await Promise.all([
    readFile(new URL('./MainContent.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../settings/view/tabs/browser-use-settings/BrowserUseSettingsTab.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(settings, /CustomEvent\('browserUseSettingsChanged'.*enabled: data\.data\.settings\.enabled/);
  assert.match(mainContent, /event instanceof CustomEvent/);
  assert.match(mainContent, /setBrowserUseEnabled\(event\.detail\.enabled\)/);
  assert.match(mainContent, /!shouldShowBrowserTab && activeTab === 'browser'/);
  assert.match(mainContent, /setActiveTab\('chat'\)/);
});
