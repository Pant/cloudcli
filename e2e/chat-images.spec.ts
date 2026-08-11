import { expect, test } from '@playwright/test';

test('image-heavy viewport fetches only intersecting thumbnails and keeps fixed cards', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/assets/images/**', async (route) => {
    requests.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') });
  });
  await page.setContent(`<!doctype html><style>.viewport{height:240px;overflow:auto}.spacer{height:700px}.card{box-sizing:border-box;display:block;width:112px;height:112px;min-height:112px}</style><div class="viewport"><button class="card" data-path="one.png"></button><button class="card" data-path="two.png"></button><div class="spacer"></div><button class="card" data-path="offscreen.png"></button></div><script>
    const observer=new IntersectionObserver(es=>es.forEach(async e=>{if(e.isIntersecting&&!e.target.dataset.loaded){e.target.dataset.loaded='1';await fetch('http://cloudcli.test/api/assets/images/'+e.target.dataset.path+'/thumbnail')}}),{root:document.querySelector('.viewport'),rootMargin:'240px'});
    document.querySelectorAll('.card').forEach(card=>observer.observe(card));
  </script>`);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests).toEqual(['/api/assets/images/one.png/thumbnail', '/api/assets/images/two.png/thumbnail']);
  const geometry = await page.locator('.card').evaluateAll((cards) => cards.map((card) => ({ width: card.getBoundingClientRect().width, height: card.getBoundingClientRect().height })));
  expect(geometry.every(({ width, height }) => width === 112 && height === 112)).toBe(true);
  await page.locator('.viewport').evaluate((viewport) => { viewport.scrollTop = viewport.scrollHeight; });
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toBe('/api/assets/images/offscreen.png/thumbnail');
});
