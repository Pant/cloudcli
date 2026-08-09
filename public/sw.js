// Service Worker for CloudCLI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
const CACHE_NAME = 'claude-ui-v2';
const urlsToCache = [
  '/manifest.json'
];

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          status: 503,
          headers: { 'Content-Type': 'text/html' }
        })
      )
    );
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build
  if (url.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network-first
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(event.request);
      return cached || new Response('Resource unavailable while offline.', { status: 503 });
    })
  );
});

// Activate event — purge old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };
  if (payload.data?.severity !== 'info') {
    options.badge = '/logo-128.png';
  }

  const isPrimaryCompletion = payload.data?.code === 'run.stopped'
    && payload.data?.stopReason === 'completed';
  const isSubtaskCompletion = payload.data?.code === 'task.completed';
  const isOpenCodeCompletion = payload.data?.provider === 'opencode'
    && (isPrimaryCompletion || isSubtaskCompletion);
  const isReplyableCompletion = isPrimaryCompletion
    && payload.data?.replyEligible === true;
  if (isOpenCodeCompletion) {
    options.vibrate = [200, 100, 200];
  }
  if (isReplyableCompletion) {
    // Notification actions and vibration are best-effort; unsupported browsers
    // ignore these standard options without affecting notification delivery.
    options.actions = [{ action: 'reply', title: 'Reply' }];
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CloudCLI', options).catch(() => {
      if (!isOpenCodeCompletion && !isReplyableCompletion) return undefined;
      const fallbackOptions = { ...options };
      delete fallbackOptions.vibrate;
      delete fallbackOptions.actions;
      return self.registration.showNotification(payload.title || 'CloudCLI', fallbackOptions);
    })
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';
  const isReply = event.action === 'reply' && Boolean(sessionId);
  const targetUrl = isReply
    ? `${urlPath}?notificationReply=1`
    : urlPath;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath,
            reply: isReply
          });
          return;
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
