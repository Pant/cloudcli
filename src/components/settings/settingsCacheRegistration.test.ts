import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTINGS_MAIN_TABS } from './constants/constants';
import { KNOWN_MAIN_TABS, normalizeMainTab } from './hooks/useSettingsController';

test('cache is registered and accepted as a settings initial tab', () => {
  assert.ok(KNOWN_MAIN_TABS.includes('cache'));
  assert.equal(normalizeMainTab('cache'), 'cache');
  assert.equal(normalizeMainTab('not-a-settings-tab'), 'agents');

  const cacheCommand = SETTINGS_MAIN_TABS.find((tab) => tab.id === 'cache');
  assert.deepEqual(cacheCommand && {
    label: cacheCommand.label,
    keywords: cacheCommand.keywords,
  }, {
    label: 'Cache',
    keywords: 'cache histories sessions messages storage',
  });
});
