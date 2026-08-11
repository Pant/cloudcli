import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import sharp from 'sharp';
import { validateManifest } from './pwa-assets.mjs';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('public/manifest.json', root), 'utf8'));
const html = await readFile(new URL('index.html', root), 'utf8');
const readPublic = (src) => readFile(new URL(`public/${src}`, root));

test('install metadata is branded, relative, and backed by valid assets', async () => {
  assert.deepEqual(await validateManifest(manifest, readPublic), []);
  assert.match(html, /rel="manifest" href="\.\/manifest\.json"/);
  assert.match(html, /apple-mobile-web-app-title" content="CloudCLI"/);
  assert.doesNotMatch(html, /Claude UI/);
});

test('asset validation rejects missing, mislabeled, and duplicated physical sizes', async () => {
  const missing = structuredClone(manifest);
  missing.icons[0].src = 'icons/missing.png';
  assert.match((await validateManifest(missing, readPublic)).join('\n'), /cannot be read/);

  const mislabeled = structuredClone(manifest);
  mislabeled.icons[0].sizes = '191x191';
  assert.match((await validateManifest(mislabeled, readPublic)).join('\n'), /declared 191x191/);

  const duplicate = structuredClone(manifest);
  duplicate.icons[1].src = duplicate.icons[0].src;
  duplicate.icons[1].sizes = duplicate.icons[0].sizes;
  assert.match((await validateManifest(duplicate, readPublic)).join('\n'), /duplicates physical icon size/);

  const png = await sharp({ create: { width: 192, height: 192, channels: 4, background: '#000' } }).jpeg().toBuffer();
  const wrongType = structuredClone(manifest);
  assert.match((await validateManifest(wrongType, async (src) => src === wrongType.icons[0].src ? png : readPublic(src))).join('\n'), /declared image\/png/);
});
