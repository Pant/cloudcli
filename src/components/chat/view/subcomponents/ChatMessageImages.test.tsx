import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('chat image requests are intersection-gated with fixed overscan geometry and async decoding', async () => {
  const source = await readFile(new URL('./ChatMessageImages.tsx', import.meta.url), 'utf8');
  assert.match(source, /new IntersectionObserver/);
  assert.match(source, /rootMargin: '240px'/);
  assert.match(source, /useChatImageSrc\(image, projectId, visible, true\)/);
  assert.match(source, /h-28 w-28/);
  assert.equal(source.match(/decoding="async"/g)?.length, 2);
  assert.match(source, /\/thumbnail/);
  assert.match(source, /OriginalImageLightbox/);
});
