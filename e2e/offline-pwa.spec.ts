import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString('base64url')}.fixture`;
const user = { id: 'offline-user', username: 'Offline User' };
const project = {
  projectId: 'offline-project', path: '/fixture', fullPath: '/fixture', displayName: 'Offline Fixture', isStarred: true,
  sessions: [
    { id: 'cached-session', summary: 'Cached session', __provider: 'claude', __projectId: 'offline-project' },
    { id: 'uncached-session', summary: 'Uncached session', __provider: 'claude', __projectId: 'offline-project' },
  ],
  sessionMeta: { hasMore: false, total: 2, rootTotal: 2, rootOffset: 0, nextOffset: 0 },
};

async function mockBackend(context: BrowserContext) {
  await context.route('**/offline-fixture-sw.js', route => route.fulfill({ contentType: 'application/javascript', body: `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => { if (event.request.method !== 'GET') return; event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then(r => r || caches.match('/index.html')))); });
` }));
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown = {};
    if (path.endsWith('/api/auth/status')) body = { needsSetup: false };
    else if (path.endsWith('/api/auth/user')) body = { user };
    else if (path.endsWith('/api/user/onboarding-status')) body = { hasCompletedOnboarding: true };
    else if (path.endsWith('/api/projects')) body = [project];
    else if (path.includes('/api/providers/sessions/cached-session')) body = { data: { sessionId: 'cached-session', provider: 'claude', summary: 'Cached session', project } };
    else if (path.includes('/api/providers/sessions/uncached-session')) body = { data: { sessionId: 'uncached-session', provider: 'claude', summary: 'Uncached session', project } };
    else if (path.includes('/messages') && path.includes('cached-session')) body = { messages: [{ id: 'cached-message', type: 'assistant', content: 'Saved canonical transcript', timestamp: new Date(0).toISOString() }], total: 1, hasMore: false, revision: 'fixture-1' };
    else if (path.includes('/messages')) body = { messages: [], total: 0, hasMore: false, revision: 'fixture-empty' };
    else if (path.endsWith('/api/providers/running') || path.includes('/lifecycle')) body = [];
    else if (path.includes('/appointments')) body = { data: [] };
    else if (path.includes('/browser-use/settings')) body = { success: true, data: { settings: { enabled: false } } };
    else if (path.includes('/models')) body = { models: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function seedAuthenticatedVisit(page: Page, path = '/') {
  await page.addInitScript(({ tokenValue, cachedUser, cachedProjects }) => {
    localStorage.setItem('auth-token', tokenValue);
    localStorage.setItem('cloudcli:offline-user', JSON.stringify(cachedUser));
    localStorage.setItem('cloudcli:offline-navigation:offline-user', JSON.stringify(cachedProjects));
  }, { tokenValue: token, cachedUser: user, cachedProjects: [project] });
  await page.goto(path);
  await expect(page.locator('body')).not.toContainText('Login');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.evaluate(async () => {
        const cache = await caches.open('cloudcli-offline-browser-fixture');
        const resources = performance.getEntriesByType('resource').map(entry => entry.name).filter(url => new URL(url).origin === location.origin);
        await cache.addAll(['/index.html', ...resources]);
        await navigator.serviceWorker.register('/offline-fixture-sw.js', { scope: '/' });
      });
      break;
    } catch (error) {
      if (attempt === 2 || !String(error).includes('Execution context was destroyed')) throw error;
      await page.waitForLoadState('domcontentloaded');
    }
  }
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test('root and deep-link cold offline shell preserve cached and uncached session semantics', async ({ context, page }) => {
  await mockBackend(context);
  await seedAuthenticatedVisit(page, '/session/cached-session');
  await expect(page.locator('body')).not.toContainText('Login');

  await context.unroute('**/api/**');
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/CloudCLI/);
  expect(await page.evaluate(() => localStorage.getItem('cloudcli:offline-user'))).toContain('Offline User');

  await page.goto('/session/uncached-session', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/uncached-session/);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/CloudCLI/);
});

test('offline send retention, notification deep links, and recovery data remain local', async ({ context, page }) => {
  await mockBackend(context);
  await seedAuthenticatedVisit(page, '/session/cached-session');
  await page.evaluate(() => {
    localStorage.setItem('queued_message_cached-session', JSON.stringify({ text: 'not delivered', attachments: [] }));
    localStorage.setItem('draft_offline-project', 'retained draft');
    sessionStorage.setItem('cloudcli:notification-reply-intent', JSON.stringify({ sessionId: 'cached-session', createdAt: Date.now() }));
  });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/CloudCLI/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('queued_message_cached-session') ?? 'null')?.text)).toBe('not delivered');
  expect(await page.evaluate(() => localStorage.getItem('draft_offline-project'))).toBe('retained draft');
  await page.goto('/session/cached-session?notificationReply=1', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/session\/cached-session/);
});

test('multi-tab offline recovery preserves queued and interrupted work', async ({ context, page }) => {
  await mockBackend(context);
  await seedAuthenticatedVisit(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.locator('body')).not.toContainText('Login');

  await page.evaluate(() => {
    localStorage.setItem('queued_message_cached-session', JSON.stringify({ text: 'pending queue' }));
    localStorage.setItem('cloudcli:interrupted-update', JSON.stringify({ dirtyEditor: true, activeRun: true, pendingQueue: true }));
    window.dispatchEvent(new CustomEvent('cloudcli:flush-durable-state'));
  });
  expect(await second.evaluate(() => JSON.parse(localStorage.getItem('cloudcli:interrupted-update') ?? 'null'))).toEqual({ dirtyEditor: true, activeRun: true, pendingQueue: true });

  const registration = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { scope: registration.scope, hasController: Boolean(navigator.serviceWorker.controller) };
  });
  expect(registration.scope).toBe(new URL('/', page.url()).href);
  expect(registration.hasController).toBe(true);

  await context.setOffline(true);
  await Promise.all([page.reload({ waitUntil: 'domcontentloaded' }), second.reload({ waitUntil: 'domcontentloaded' })]);
  await expect(page).toHaveTitle(/CloudCLI/);
  await expect(second).toHaveTitle(/CloudCLI/);
  expect(await page.evaluate(() => localStorage.getItem('queued_message_cached-session'))).toContain('pending queue');
  expect(await page.evaluate(() => localStorage.getItem('cloudcli:interrupted-update'))).toContain('dirtyEditor');
  await second.close();
});
