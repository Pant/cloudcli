import { expect, test } from '@playwright/test';

test('built worker registers, owns only CloudCLI caches, and launches cached shell offline', async ({ page, context, baseURL }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean))).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const state = await page.evaluate(async () => ({
    scope: (await navigator.serviceWorker.getRegistration())?.scope,
    caches: await caches.keys(),
    manifest: document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href,
  }));
  expect(state.scope).toBe(new URL('/', baseURL).href);
  expect(state.manifest).toBe(new URL('/manifest.json', baseURL).href);
  expect(state.caches.length).toBeGreaterThan(0);
  expect(state.caches.every(name => name.startsWith('cloudcli-'))).toBe(true);

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/CloudCLI/);
});

test('worker preserves foreign caches and exposes scoped notification/update handlers', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => { const cache = await caches.open('foreign-product-cache'); await cache.put('/foreign', new Response('kept')); });
  const worker = await (await import('node:fs/promises')).readFile('dist/sw.js', 'utf8');
  expect(worker).toContain('cloudcli:check-update');
  expect(worker).toContain('notificationclick');
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  expect(await page.evaluate(() => caches.has('foreign-product-cache'))).toBe(true);
});
