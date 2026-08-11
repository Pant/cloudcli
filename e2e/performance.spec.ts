import { expect, test } from '@playwright/test';

const HARD_LIMITS = { requests: 35, scriptBytes: 2_000_000, styleBytes: 500_000 };

for (const profile of ['cold', 'warm', 'installed'] as const) {
  test(`${profile} startup has bounded resources and records milestones`, async ({ page }, testInfo) => {
    if (profile === 'installed') await page.addInitScript(() => Object.defineProperty(window, 'matchMedia', { value: (query: string) => ({ matches: query.includes('display-mode: standalone'), media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) }));
    if (profile === 'warm') { await page.goto('/'); await page.waitForLoadState('networkidle'); }
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const sample = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const bytes = (kind: string) => resources.filter(entry => entry.initiatorType === kind || entry.name.includes(`.${kind === 'script' ? 'js' : 'css'}`)).reduce((total, entry) => total + entry.transferSize, 0);
      return { requests: resources.length, scriptBytes: bytes('script'), styleBytes: bytes('link'), milestones: performance.getEntriesByType('measure').filter(entry => entry.name.startsWith('cloudcli')).map(entry => ({ name: entry.name, duration: entry.duration })) };
    });
    await testInfo.attach(`performance-${profile}.json`, { body: Buffer.from(JSON.stringify(sample, null, 2)), contentType: 'application/json' });
    expect(sample.requests).toBeLessThanOrEqual(HARD_LIMITS.requests);
    expect(sample.scriptBytes).toBeLessThanOrEqual(HARD_LIMITS.scriptBytes);
    expect(sample.styleBytes).toBeLessThanOrEqual(HARD_LIMITS.styleBytes);
    expect(sample.milestones.every(item => Number.isFinite(item.duration))).toBe(true);
  });
}
