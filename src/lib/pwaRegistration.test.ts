import assert from 'node:assert/strict';
import test from 'node:test';

import { createPwaRegistrationController, getPwaBaseUrl } from './pwaRegistration';

test('PWA base follows deployment-root manifest metadata instead of nested routes', () => {
  assert.equal(getPwaBaseUrl('https://cloudcli.test/', '/manifest.json').href, 'https://cloudcli.test/');
  assert.equal(getPwaBaseUrl('https://cloudcli.test/session/123', '/manifest.json').href, 'https://cloudcli.test/');
  assert.equal(getPwaBaseUrl('https://cloudcli.test/cloudcli/session/123', '/cloudcli/manifest.json').href, 'https://cloudcli.test/cloudcli/');
  assert.equal(getPwaBaseUrl('https://cloudcli.test/session/123', 'https://assets.test/app/manifest.json').href, 'https://assets.test/app/');
});

test('production registers exactly once after load with a subpath scope', async () => {
  let load: (() => void) | undefined;
  let updates = 0;
  const calls: Array<{ url: string; scope?: string; updateViaCache?: ServiceWorkerUpdateViaCache }> = [];
  const registration = { update: async () => { updates += 1; return registration; } } as unknown as ServiceWorkerRegistration;
  const serviceWorker = {
    register: async (url: string | URL, options?: RegistrationOptions) => { calls.push({ url: String(url), ...options }); return registration; },
  } as ServiceWorkerContainer;
  const start = createPwaRegistrationController({
    production: true,
    serviceWorker,
    window: { addEventListener: (_name: string, listener: EventListenerOrEventListenerObject) => { load = listener as () => void; } } as Window,
    baseUrl: () => new URL('https://cloudcli.test/ai/'),
  });
  const pending = start();
  assert.equal(calls.length, 0);
  load?.();
  assert.equal(await pending, registration);
  assert.deepEqual(calls, [{ url: 'https://cloudcli.test/ai/sw.js', scope: '/ai/', updateViaCache: 'none' }]);
  assert.equal(updates, 0);
});

test('development unregisters only existing CloudCLI worker registrations', async () => {
  const removed: string[] = [];
  const registrations = ['/sw.js', '/other-worker.js', '/ai/sw.js'].map(scriptURL => ({
    active: { scriptURL: `https://cloudcli.test${scriptURL}` },
    unregister: async () => { removed.push(scriptURL); return true; },
  })) as unknown as ServiceWorkerRegistration[];
  const result = await createPwaRegistrationController({
    production: false,
    serviceWorker: { getRegistrations: async () => registrations } as unknown as ServiceWorkerContainer,
    window: {} as Window,
    baseUrl: () => new URL('https://cloudcli.test/'),
  })();
  assert.equal(result, null);
  assert.deepEqual(removed, ['/sw.js', '/ai/sw.js']);
});
