import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8'))
  .replace('__CLOUDCLI_BUILD_ID__', 'build-7')
  .replace('__CLOUDCLI_SHELL__', JSON.stringify(['index.html', 'manifest.json', 'assets/app-123.js']));

function harness(scope = 'https://cloudcli.test/') {
  const listeners = new Map();
  const stores = new Map();
  const deletedCaches = [];
  const putCalls = [];
  const addAllCalls = [];
  const fetchCalls = [];
  const opened = [];
  const messages = [];
  let skipWaiting = 0;
  let update = 0;
  const cache = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      addAll: async urls => { addAllCalls.push({ name, urls }); },
      match: async request => entries.get(typeof request === 'string' ? request : request.url),
      put: async (request, response) => { putCalls.push({ name, url: request.url }); entries.set(request.url, response); },
      keys: async () => [...entries.keys()].map(url => ({ url })),
      delete: async request => entries.delete(request.url),
    };
  };
  const clients = [];
  const self = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    registration: { scope, update: async () => { update += 1; }, showNotification: async () => {} },
    clients: { claim: async () => {}, matchAll: async () => clients, openWindow: async url => { opened.push(url); } },
    skipWaiting: () => { skipWaiting += 1; },
    location: { origin: new URL(scope).origin },
  };
  const caches = {
    open: async name => cache(name),
    keys: async () => [...stores.keys()],
    delete: async name => { deletedCaches.push(name); return stores.delete(name); },
    match: async request => { for (const entries of stores.values()) { const found = entries.get(typeof request === 'string' ? request : request.url); if (found) return found; } },
  };
  let fetchImpl = async request => { fetchCalls.push(request.url); return new Response('network'); };
  vm.runInNewContext(source, { self, caches, fetch: request => fetchImpl(request), Response, URL });
  const run = async (name, event = {}) => {
    let pending;
    let response;
    listeners.get(name)({ ...event, waitUntil: promise => { pending = promise; }, respondWith: promise => { response = promise; } });
    await pending;
    return response ? response : undefined;
  };
  return { listeners, stores, deletedCaches, putCalls, addAllCalls, fetchCalls, opened, messages, clients, run,
    setFetch: fn => { fetchImpl = fn; }, counts: () => ({ skipWaiting, update }) };
}

const request = (url, { method = 'GET', mode = 'cors' } = {}) => ({ url, method, mode });

test('install precaches the generated scoped shell without activating early', async () => {
  const h = harness('https://cloudcli.test/ai/');
  await h.run('install');
  assert.deepEqual(Array.from(h.addAllCalls[0].urls), ['https://cloudcli.test/ai/index.html', 'https://cloudcli.test/ai/manifest.json', 'https://cloudcli.test/ai/assets/app-123.js']);
  assert.equal(h.counts().skipWaiting, 0);
});

test('fetch excludes cross-origin, API, and mutation requests', () => {
  const h = harness();
  for (const value of [request('https://other.test/a.js'), request('https://cloudcli.test/api/data'), request('https://cloudcli.test/file', { method: 'POST' })]) {
    let intercepted = false;
    h.listeners.get('fetch')({ request: value, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});

test('navigation falls back to the cached shell and shell resources are cache-first', async () => {
  const h = harness('/ai/'.startsWith('http') ? '/ai/' : 'https://cloudcli.test/ai/');
  const shell = new Response('shell');
  h.stores.set('cloudcli-pwa-build-7-shell', new Map([['https://cloudcli.test/ai/index.html', shell], ['https://cloudcli.test/ai/assets/app-123.js', new Response('asset')]]));
  h.setFetch(async () => { throw new Error('offline'); });
  assert.equal(await (await h.run('fetch', { request: request('https://cloudcli.test/ai/session/1', { mode: 'navigate' }) })).text(), 'shell');
  assert.equal(await (await h.run('fetch', { request: request('https://cloudcli.test/ai/assets/app-123.js') })).text(), 'asset');
});

test('runtime stores only successful non-opaque same-origin responses', async () => {
  for (const response of [new Response('ok'), new Response('bad', { status: 500 }), { ok: true, type: 'opaque', clone() { return this; } }]) {
    const h = harness();
    h.setFetch(async () => response);
    await h.run('fetch', { request: request('https://cloudcli.test/image.png') });
    assert.equal(h.putCalls.length, response instanceof Response && response.ok ? 1 : 0);
  }
});

test('activation removes only obsolete CloudCLI cache versions', async () => {
  const h = harness();
  for (const name of ['cloudcli-pwa-old-shell', 'cloudcli-pwa-build-7-shell', 'cloudcli-pwa-build-7-runtime', 'foreign-cache']) h.stores.set(name, new Map());
  await h.run('activate');
  assert.deepEqual(h.deletedCaches, ['cloudcli-pwa-old-shell']);
});

test('update messages check and explicitly activate the waiting worker', async () => {
  const h = harness();
  await h.run('message', { data: { type: 'cloudcli:check-update' } });
  await h.run('message', { data: { type: 'cloudcli:activate-update' } });
  assert.deepEqual(h.counts(), { skipWaiting: 1, update: 1 });
});

test('notification clicks focus scoped clients or open root/subpath URLs', async () => {
  for (const scope of ['https://cloudcli.test/', 'https://cloudcli.test/ai/']) {
    const h = harness(scope);
    const notification = { data: { sessionId: 'a/b', provider: 'opencode' }, close() {} };
    await h.run('notificationclick', { notification, action: 'reply' });
    assert.equal(h.opened[0], `${scope}session/a%2Fb?notificationReply=1`);
    const posted = [];
    h.clients.push({ url: `${scope}session/old`, focus: async () => {}, postMessage: message => posted.push(message) });
    await h.run('notificationclick', { notification, action: '' });
    assert.equal(posted[0].urlPath, `${new URL(scope).pathname}session/a%2Fb`);
  }
});
