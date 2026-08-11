import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';

import { getProviderStartupOrder, providerModelsUrl } from './useChatProviderState';
import {
  BUILT_IN_COMMANDS,
  clearRemoteCatalogRequestsForTests,
  loadSlashCommandCatalogs,
} from './useSlashCommands';

test('selected provider is the only immediate normal-cache request and others defer', () => {
  assert.deepEqual(getProviderStartupOrder('opencode'), {
    immediate: ['opencode'],
    deferred: ['claude', 'cursor', 'codex'],
  });
  assert.equal(providerModelsUrl('opencode'), '/api/providers/opencode/models');
  assert.equal(providerModelsUrl('opencode', true), '/api/providers/opencode/models?bypassCache=true');
});

test('built-ins require no request and intent loads commands and skills concurrently once', async () => {
  clearRemoteCatalogRequestsForTests();
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  assert.deepEqual(BUILT_IN_COMMANDS.map((command) => command.name), ['/help', '/models', '/cost', '/memory', '/config', '/status']);
  const project = { projectId: 'p1', path: '/workspace' } as Project;
  const calls: string[] = [];
  const releases: Array<() => void> = [];
  const fetcher = ((url: string) => {
    calls.push(url);
    return new Promise<Response>((resolve) => {
      releases.push(() => resolve(new Response(JSON.stringify(
        url === '/api/commands/list'
          ? { custom: [{ name: '/custom' }] }
          : { data: { skills: [{ name: 'Skill', command: '/skill', scope: 'project' }] } },
      ), { status: 200 })));
    });
  }) as typeof fetch;

  const first = loadSlashCommandCatalogs({ selectedProject: project, provider: 'opencode', fetcher });
  const second = loadSlashCommandCatalogs({ selectedProject: project, provider: 'opencode', fetcher });
  assert.equal(calls.length, 2);
  assert.equal(releases.length, 2);
  releases.forEach((release) => release());
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one.map((command) => command.name), two.map((command) => command.name));
  assert.ok(one.some((command) => command.name === '/custom'));
  assert.ok(one.some((command) => command.name === '/skill'));
  assert.equal(calls.length, 2);
});
