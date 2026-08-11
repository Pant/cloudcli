const BUILD_ID = '__CLOUDCLI_BUILD_ID__';
const SHELL_FILES = __CLOUDCLI_SHELL__;
const CACHE_PREFIX = 'cloudcli-pwa-';
const SHELL_CACHE = `${CACHE_PREFIX}${BUILD_ID}-shell`;
const RUNTIME_CACHE = `${CACHE_PREFIX}${BUILD_ID}-runtime`;
const RUNTIME_LIMIT = 80;

const scopedUrl = path => new URL(path, self.registration.scope).href;
const isCloudCliCache = name => name.startsWith(CACHE_PREFIX);
const isEligibleResponse = response => response && response.ok && response.type !== 'opaque';
const isApiPath = pathname => pathname === '/api' || pathname.includes('/api/');

async function trimRuntimeCache(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - RUNTIME_LIMIT)).map(key => cache.delete(key)));
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES.map(scopedUrl))));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => isCloudCliCache(name) && name !== SHELL_CACHE && name !== RUNTIME_CACHE)
    .map(name => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'cloudcli:activate-update') self.skipWaiting();
  if (event.data?.type === 'cloudcli:check-update') event.waitUntil(self.registration.update());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET' || isApiPath(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => isEligibleResponse(response) ? response : Promise.reject(new Error('Navigation unavailable'))).catch(() => caches.match(scopedUrl('index.html'))));
    return;
  }

  const inScope = url.href.startsWith(self.registration.scope);
  if (!inScope) return;
  const shellRequest = SHELL_FILES.some(path => scopedUrl(path) === url.href);
  if (shellRequest) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
    return;
  }

  event.respondWith(fetch(request).then(async response => {
    if (isEligibleResponse(response)) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
      await trimRuntimeCache(cache);
    }
    return response;
  }).catch(() => caches.match(request).then(cached => cached || new Response('Resource unavailable while offline.', { status: 503 }))));
});

self.addEventListener('push', event => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { payload = { title: 'CloudCLI', body: event.data.text() }; }
  const options = {
    body: payload.body || '', icon: scopedUrl('logo-256.png'), data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`, renotify: true
  };
  if (payload.data?.severity !== 'info') options.badge = scopedUrl('logo-128.png');
  const primary = payload.data?.code === 'run.stopped' && payload.data?.stopReason === 'completed';
  const completion = payload.data?.provider === 'opencode' && (primary || payload.data?.code === 'task.completed');
  const replyable = primary && payload.data?.replyEligible === true;
  if (completion) options.vibrate = [200, 100, 200];
  if (replyable) options.actions = [{ action: 'reply', title: 'Reply' }];
  event.waitUntil(self.registration.showNotification(payload.title || 'CloudCLI', options).catch(() => {
    const fallback = { ...options }; delete fallback.vibrate; delete fallback.actions;
    return self.registration.showNotification(payload.title || 'CloudCLI', fallback);
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const relativePath = sessionId ? `session/${encodeURIComponent(sessionId)}` : '';
  const urlPath = new URL(relativePath, self.registration.scope).pathname;
  const isReply = event.action === 'reply' && Boolean(sessionId);
  const targetUrl = new URL(isReply ? `${relativePath}?notificationReply=1` : relativePath, self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const scopedClient = clients.find(client => client.url.startsWith(self.registration.scope));
    if (scopedClient) {
      await scopedClient.focus();
      scopedClient.postMessage({ type: 'notification:navigate', sessionId: sessionId || null, provider, urlPath, reply: isReply });
      return;
    }
    return self.clients.openWindow(targetUrl);
  }));
});
