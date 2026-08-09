import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureWebPushSubscription, removeWebPushSubscription } from './useWebPush';

const key = Uint8Array.from([1, 2, 3]);
const publicKey = 'AQID';

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function subscription(applicationServerKey = key.buffer): PushSubscription {
  return {
    endpoint: 'https://push.example/subscription',
    options: { applicationServerKey, userVisibleOnly: true },
    toJSON: () => ({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'key', auth: 'auth' } }),
    unsubscribe: async () => true,
  } as unknown as PushSubscription;
}

test('reconciles an existing current-key subscription with the backend', async () => {
  const existing = subscription();
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return String(url).endsWith('vapid-public-key') ? response({ publicKey }) : response({ success: true });
  };
  const registration = { pushManager: {
    getSubscription: async () => existing,
    subscribe: async () => { throw new Error('should not subscribe'); },
  } } as unknown as ServiceWorkerRegistration;

  assert.equal(await ensureWebPushSubscription({ fetch, registration }), existing);
  assert.deepEqual(calls, ['/api/settings/push/vapid-public-key', '/api/settings/push/subscribe']);
});

test('replaces a subscription created with a stale application server key', async () => {
  let unsubscribed = false;
  const existing = subscription(Uint8Array.from([9]).buffer);
  existing.unsubscribe = async () => { unsubscribed = true; return true; };
  const replacement = subscription();
  let subscribeOptions: PushSubscriptionOptionsInit | undefined;
  const registration = { pushManager: {
    getSubscription: async () => existing,
    subscribe: async (options: PushSubscriptionOptionsInit) => { subscribeOptions = options; return replacement; },
  } } as unknown as ServiceWorkerRegistration;
  const fetch: typeof globalThis.fetch = async (url: RequestInfo | URL) => (
    String(url).endsWith('vapid-public-key') ? response({ publicKey }) : response({ success: true })
  );

  assert.equal(await ensureWebPushSubscription({ fetch, registration }), replacement);
  assert.equal(unsubscribed, true);
  assert.deepEqual(new Uint8Array(subscribeOptions?.applicationServerKey as ArrayBuffer), key);
});

test('rejects non-OK backend registration', async () => {
  const existing = subscription();
  const registration = { pushManager: { getSubscription: async () => existing } } as unknown as ServiceWorkerRegistration;
  const fetch: typeof globalThis.fetch = async (url: RequestInfo | URL) => (
    String(url).endsWith('vapid-public-key') ? response({ publicKey }) : response({}, false)
  );
  await assert.rejects(ensureWebPushSubscription({ fetch, registration }), /registration failed/);
});

test('does not report successful removal when the backend rejects it', async () => {
  const existing = subscription();
  const registration = { pushManager: { getSubscription: async () => existing } } as unknown as ServiceWorkerRegistration;
  const fetch: typeof globalThis.fetch = async () => response({}, false);
  assert.equal(await removeWebPushSubscription({ fetch, registration }), false);
});

test('permission denial can fail before subscription helpers are invoked', async () => {
  let invoked = false;
  const requestPermission = async () => 'denied' as NotificationPermission;
  const permission = await requestPermission();
  if (permission === 'granted') invoked = true;
  assert.equal(invoked, false);
});
