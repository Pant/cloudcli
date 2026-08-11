import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectTargets } from '../skills/hooks/useProviderSkills';

import { SETTINGS_MAIN_TABS } from './constants/constants';
import { KNOWN_MAIN_TABS, normalizeMainTab } from './hooks/useSettingsController';

test('skills follows agents and is accepted as an initial tab', () => {
  assert.equal(normalizeMainTab('skills'), 'skills');
  assert.equal(KNOWN_MAIN_TABS.indexOf('skills'), KNOWN_MAIN_TABS.indexOf('agents') + 1);
  assert.equal(SETTINGS_MAIN_TABS.findIndex((tab) => tab.id === 'skills'), SETTINGS_MAIN_TABS.findIndex((tab) => tab.id === 'agents') + 1);
});

test('project targets use real paths and deduplicate them', () => {
  assert.deepEqual(createProjectTargets([
    { projectId: 'one', displayName: 'One', fullPath: '/work/one' },
    { projectId: 'duplicate', path: '/work/one' },
    { projectId: 'two', path: '/work/two' },
    { projectId: 'missing' },
  ]), [
    { projectId: 'one', displayName: 'One', path: '/work/one' },
    { projectId: 'two', displayName: 'two', path: '/work/two' },
  ]);
});
