import { expect, test } from '@playwright/test';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const externalFontHost = /fonts\.(?:googleapis|gstatic)\.com/;

async function installClsObserver(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    (window as any).__fontCls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) (window as any).__fontCls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

test('cold and offline dark launches use local UI fonts without material CLS', async ({ page, context }) => {
  await installClsObserver(page);
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  expect(await page.locator('meta[name="theme-color"]:not([media])').getAttribute('content')).toBe('#141414');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
  expect(requests.some(url => externalFontHost.test(url))).toBe(false);
  expect(requests.filter(url => /\/fonts\/encode-sans-.*\.woff2$/.test(url)).length).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => (window as any).__fontCls)).toBeLessThan(0.01);

  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  expect(await page.locator('meta[name="theme-color"]:not([media])').getAttribute('content')).toBe('#141414');
  expect(await page.evaluate(() => (window as any).__fontCls)).toBeLessThan(0.01);
});

test('KaTeX resources remain absent for no-math and load only for a math surface', async ({ page }) => {
  const assets = await readdir(path.join(process.cwd(), 'dist/assets'));
  const katexCss = assets.find(file => /^katex-.*\.css$/.test(file));
  expect(katexCss).toBeTruthy();
  const requests: string[] = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(requests.some(url => /katex|KaTeX/.test(url))).toBe(false);

  await page.evaluate((href) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
    const math = document.createElement('span');
    math.className = 'katex';
    math.innerHTML = '<span class="katex-mathml">x</span><span class="katex-html"><span class="mord mathnormal">x</span></span>';
    document.body.append(math);
  }, `/assets/${katexCss}`);
  await expect.poll(() => requests.some(url => url.endsWith(`/assets/${katexCss}`))).toBe(true);
  expect(requests.some(url => /KaTeX_.*\.(?:woff2?|ttf)$/.test(url))).toBe(false);
});
