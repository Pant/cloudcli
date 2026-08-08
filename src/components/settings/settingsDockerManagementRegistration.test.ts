import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTINGS_MAIN_TABS } from './constants/constants';
import { KNOWN_MAIN_TABS, normalizeMainTab } from './hooks/useSettingsController';
import {
  DockerManagementRequestError,
  requestDockerBuild,
  requestDockerDown,
  requestDockerRestart,
} from './services/dockerManagementApi';

test('docker management is registered and accepted as a settings initial tab', () => {
  assert.ok(KNOWN_MAIN_TABS.includes('docker-management'));
  assert.equal(normalizeMainTab('docker-management'), 'docker-management');
  assert.equal(normalizeMainTab('not-a-settings-tab'), 'agents');
  const command = SETTINGS_MAIN_TABS.find((tab) => tab.id === 'docker-management');
  assert.deepEqual(command && { label: command.label, keywords: command.keywords }, {
    label: 'Docker Management',
    keywords: 'docker management build restart containers',
  });
});

test('docker management helpers POST only to fixed endpoints without consuming response bodies', async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let bodyRead = false;
  const fetcher = async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return {
      status: 202,
      text: async () => { bodyRead = true; return ''; },
      json: async () => { bodyRead = true; return {}; },
      body: { getReader: () => { bodyRead = true; return {}; } },
    } as unknown as Response;
  };
  await requestDockerBuild(fetcher);
  await requestDockerRestart(fetcher);
  await requestDockerDown(fetcher);
  assert.deepEqual(calls, [
    { url: '/api/settings/docker-management/build', options: { method: 'POST' } },
    { url: '/api/settings/docker-management/restart', options: { method: 'POST' } },
    { url: '/api/settings/docker-management/down', options: { method: 'POST' } },
  ]);
  assert.equal(bodyRead, false);
});

test('docker management helpers derive failure from response status only', async () => {
  const fetcher = async () => ({ status: 409 }) as Response;
  await assert.rejects(requestDockerBuild(fetcher), (error: unknown) => (
    error instanceof DockerManagementRequestError && error.status === 409
  ));
});
