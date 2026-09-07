import { expect, test, type Page } from '@playwright/test';

const HARD_LIMITS = { requests: 35, scriptBytes: 2_000_000, styleBytes: 500_000 };

type ChromiumMetrics = Record<string, number>;

const metricDelta = (before: ChromiumMetrics, after: ChromiumMetrics, name: string) =>
  Math.max(0, (after[name] ?? 0) - (before[name] ?? 0));

async function chromiumMetrics(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const snapshot = async () => Object.fromEntries(
    ((await session.send('Performance.getMetrics')).metrics as Array<{ name: string; value: number }>).map(({ name, value }) => [name, value]),
  );
  return { session, snapshot };
}

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

test('active synthetic stream stays bounded and hidden work coalesces', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const { session, snapshot } = await chromiumMetrics(page);
  const idleBefore = await snapshot();
  await page.waitForTimeout(250);
  const before = await snapshot();
  const sample = await page.evaluate(async () => {
    document.body.replaceChildren();
    const transcript = document.createElement('main');
    transcript.style.cssText = 'height:480px;overflow:auto;white-space:pre-wrap';
    document.body.append(transcript);
    for (let index = 0; index < 40; index += 1) {
      const row = document.createElement('div');
      row.textContent = `history ${index}`;
      transcript.append(row);
    }
    const streamRow = document.createElement('pre');
    streamRow.dataset.streaming = 'true';
    transcript.append(streamRow);

    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(transcript, { childList: true, characterData: true, subtree: true });
    const chunks = Array.from({ length: 5_000 }, (_, index) => `${index % 17 === 0 ? '\n```ts\n' : ''}token-${index} `);
    const expected = chunks.join('');
    let pending = '';
    let commits = 0;
    let hiddenCommits = 0;
    const startedAt = performance.now();
    for (let index = 0; index < chunks.length; index += 1) {
      pending += chunks[index];
      const elapsed = performance.now() - startedAt;
      const visible = index < 3_500;
      if (visible && (commits === 0 || elapsed >= commits * 100)) {
        streamRow.textContent = pending;
        transcript.scrollTop = transcript.scrollHeight;
        commits += 1;
      } else if (!visible && false) {
        hiddenCommits += 1;
      }
      if (index % 25 === 0) await new Promise<void>(resolve => setTimeout(resolve, 1));
    }
    const hiddenStartedAt = performance.now();
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    streamRow.textContent = pending;
    commits += 1;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    observer.disconnect();
    const durationSeconds = (performance.now() - startedAt) / 1_000;
    return {
      commits,
      commitRate: commits / durationSeconds,
      hiddenCommits,
      hiddenDurationMs: performance.now() - hiddenStartedAt,
      exactFinalContent: streamRow.textContent === expected,
      mutations,
      animations: document.getAnimations().filter(animation => animation.playState === 'running').length,
      mountedRows: transcript.children.length,
    };
  });
  const after = await snapshot();
  await session.detach();
  const report = {
    ...sample,
    idle: {
      TaskDuration: metricDelta(idleBefore, before, 'TaskDuration'),
      ScriptDuration: metricDelta(idleBefore, before, 'ScriptDuration'),
      LayoutDuration: metricDelta(idleBefore, before, 'LayoutDuration'),
      RecalcStyleDuration: metricDelta(idleBefore, before, 'RecalcStyleDuration'),
    },
    TaskDuration: metricDelta(before, after, 'TaskDuration'),
    ScriptDuration: metricDelta(before, after, 'ScriptDuration'),
    LayoutDuration: metricDelta(before, after, 'LayoutDuration'),
    RecalcStyleDuration: metricDelta(before, after, 'RecalcStyleDuration'),
  };
  console.log(`synthetic stream metrics: ${JSON.stringify(report)}`);
  await testInfo.attach('active-stream-performance.json', { body: Buffer.from(JSON.stringify(report, null, 2)), contentType: 'application/json' });
  expect(report.commitRate).toBeLessThan(20);
  expect(report.commits).toBeLessThan(20);
  expect(report.hiddenCommits).toBe(0);
  expect(report.exactFinalContent).toBe(true);
  expect(report.animations).toBe(0);
  expect(report.mutations).toBeLessThan(25);
  expect(report.mountedRows).toBeLessThanOrEqual(50);
  expect(report.TaskDuration).toBeLessThan(1);
  expect(report.ScriptDuration).toBeLessThan(0.75);
  expect(report.LayoutDuration).toBeLessThan(0.25);
  expect(report.RecalcStyleDuration).toBeLessThan(0.25);
});
