import { test, expect } from './fixtures/cloudcli';

const messages = (items: Array<[string, string]>) => items.map(([id, content]) => ({ id, content }));

test('cache, realtime-before-REST, and stale canonical ordering reconcile uniquely', async ({ stablePage: page }) => {
  await page.evaluate(async cached => { const h = (window as any).harness; h.state.sessions.A = cached; await h.save(); await h.load(); }, messages([['cached', 'cached row']]));
  await expect(page.locator('[data-message-key="cached"]')).toBeVisible();
  await page.evaluate(canonical => { const h=(window as any).harness; h.rest('old','A',canonical,1); h.rest('new','A',[...canonical,{id:'live',content:'canonical live'}],2); h.frame('A',1,1,{id:'live',content:'streaming'}); }, messages([['canonical', 'canonical row']]));
  await expect(page.locator('[data-message-key="live"]')).toHaveText('streaming');
  await page.evaluate(() => (window as any).harness.resolve('new'));
  await expect(page.locator('.row')).toHaveCount(2);
  await page.evaluate(() => (window as any).harness.resolve('old'));
  await expect(page.locator('[data-message-key="live"]')).toHaveText('canonical live');
});

test('replay gaps, A-B-A viewports, reload, broadcast, and token epochs are deterministic', async ({ stablePage: page, harnessUrl, context }) => {
  expect(await page.evaluate(() => (window as any).harness.frame('A',1,2,{id:'gap',content:'gap'}))).toBe('gap');
  await page.evaluate(canonical => (window as any).harness.recover('A',canonical,3), messages(Array.from({length:8},(_,i)=>['a'+i,'A '+i])));
  await page.locator('[data-testid="viewport"]').evaluate((node: HTMLElement) => node.scrollTop=80);
  await page.getByRole('button',{name:'B'}).click();
  await page.evaluate(b => { const h=(window as any).harness; h.state.sessions.B=b; h.publish?.(); }, messages(Array.from({length:8},(_,i)=>['b'+i,'B '+i])));
  await page.locator('[data-testid="viewport"]').evaluate((node: HTMLElement) => node.scrollTop=40);
  await page.getByRole('button',{name:'A'}).click();
  await expect.poll(() => page.locator('[data-testid="viewport"]').evaluate((n: HTMLElement)=>n.scrollTop)).toBe(80);
  await page.evaluate(async () => { const h=(window as any).harness; h.frame('A',2,1,{id:'stream',content:'partial'}); await h.save(); });
  await page.reload(); await expect(page.locator('[data-message-key="stream"]')).toHaveText('partial');
  const second=await context.newPage(); await second.goto(harnessUrl); await expect(second.locator('[data-message-key="stream"]')).toBeVisible();
  await page.evaluate(() => (window as any).harness.frame('A',2,2,{id:'broadcast',content:'shared'}));
  await expect(second.locator('[data-message-key="broadcast"]')).toHaveText('shared');
  expect(await page.evaluate(() => [(window as any).harness.rotateToken(),(window as any).harness.rotateToken()])).toEqual([1,2]);
  await second.close();
});

test('delayed row growth preserves anchors, non-overlap, and bottom policy', async ({ stablePage: page }) => {
  await page.evaluate(canonical => (window as any).harness.recover('A',canonical,1), messages(Array.from({length:10},(_,i)=>['m'+i,'message '+i])));
  const viewport=page.locator('[data-testid="viewport"]');
  await viewport.evaluate((n:HTMLElement)=>n.scrollTop=80);
  const before=await page.locator('[data-message-key="m2"]').boundingBox();
  await page.evaluate(() => (window as any).harness.grow('m0',100));
  await expect.poll(() => page.locator('[data-message-key="m2"]').evaluate(n=>n.getBoundingClientRect().top)).toBe(before!.y);
  const boxes=await page.locator('.row').evaluateAll(ns=>ns.map(n=>({top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom})));
  expect(boxes.every((b,i)=>i===0||b.top>=boxes[i-1].bottom)).toBe(true);
  await viewport.evaluate((n:HTMLElement)=>n.scrollTop=n.scrollHeight);
  await page.evaluate(() => (window as any).harness.grow('m9',120));
  await expect.poll(() => viewport.evaluate((n:HTMLElement)=>Math.round(n.scrollHeight-n.scrollTop-n.clientHeight))).toBe(0);
});
