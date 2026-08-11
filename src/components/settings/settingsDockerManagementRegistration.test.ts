import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTINGS_MAIN_TABS } from './constants/constants';
import { KNOWN_MAIN_TABS, normalizeMainTab } from './hooks/useSettingsController';
import {
  DockerManagementRequestError,
  appendBoundedDockerLogs,
  requestDockerBuild,
  requestDockerDown,
  requestDockerRestart,
  streamDockerLogs,
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

test('docker logs helper uses the fixed GET endpoint and decodes chunks incrementally', async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const chunks = [new TextEncoder().encode('hello '), new TextEncoder().encode('world')];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const output: string[] = [];
  await streamDockerLogs((chunk) => output.push(chunk), undefined, async (url, options) => {
    calls.push({ url, options });
    return new Response(stream, { status: 200 });
  });
  assert.deepEqual(calls, [{ url: '/api/settings/docker-management/logs', options: { method: 'GET', signal: undefined } }]);
  assert.deepEqual(output, ['hello ', 'world']);
});

test('docker logs retention is bounded and stream cancellation cancels its reader', async () => {
  assert.equal(appendBoundedDockerLogs('1234', '5678', 5), '45678');
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('chunk')); },
    cancel() { cancelled = true; },
  });
  const controller = new AbortController();
  await streamDockerLogs(() => controller.abort(), controller.signal, async () => new Response(stream));
  assert.equal(cancelled, true);
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
