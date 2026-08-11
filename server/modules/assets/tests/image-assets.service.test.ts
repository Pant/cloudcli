import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promises as fs } from 'node:fs';

import sharp from 'sharp';

import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  isAllowedImageMimeType,
  openStoredImageThumbnail,
  resolveAttachmentAssetFile,
  resolveImageAssetFile,
} from '@/modules/assets/services/image-assets.service.js';

const ASSETS_DIR = path.join(os.homedir(), '.cloudcli', 'assets');

test('isAllowedImageMimeType accepts image formats and rejects the rest', () => {
  assert.equal(isAllowedImageMimeType('image/png'), true);
  assert.equal(isAllowedImageMimeType('image/svg+xml'), true);
  assert.equal(isAllowedImageMimeType('application/pdf'), false);
  assert.equal(isAllowedImageMimeType('text/html'), false);
});

test('openStoredImageThumbnail bounds raster dimensions and preserves unsupported originals', async () => {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  const filename = `thumbnail-test-${process.pid}.png`;
  const svgFilename = `thumbnail-test-${process.pid}.svg`;
  const imagePath = path.join(ASSETS_DIR, filename);
  const svgPath = path.join(ASSETS_DIR, svgFilename);
  try {
    await sharp({ create: { width: 800, height: 400, channels: 3, background: '#336699' } }).png().toFile(imagePath);
    await fs.writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"/>');

    const thumbnail = await openStoredImageThumbnail(filename);
    assert.equal(thumbnail.status, 'found');
    if (thumbnail.status === 'found') {
      assert.equal(thumbnail.contentType, 'image/webp');
      const metadata = await sharp(thumbnail.buffer).metadata();
      assert.ok((metadata.width || 0) <= 224);
      assert.ok((metadata.height || 0) <= 224);
    }
    assert.deepEqual(await openStoredImageThumbnail(svgFilename), { status: 'unsupported' });
  } finally {
    await fs.rm(imagePath, { force: true });
    await fs.rm(svgPath, { force: true });
  }
});

test('buildStoredImageRecords returns absolute posix paths in the assets dir', () => {
  const records = buildStoredImageRecords([
    { originalname: 'shot.png', filename: '123-456-shot.png', size: 42, mimetype: 'image/png' },
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'shot.png');
  assert.equal(records[0].size, 42);
  assert.equal(records[0].mimeType, 'image/png');
  assert.equal(records[0].path, `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-shot.png`);
});

test('buildStoredAttachmentRecords preserves metadata for non-image files', () => {
  const records = buildStoredAttachmentRecords([
    {
      originalname: 'requirements.pdf',
      filename: '123-456-requirements.pdf',
      size: 2048,
      mimetype: 'application/pdf',
    },
  ]);

  assert.deepEqual(records[0], {
    name: 'requirements.pdf',
    path: `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-requirements.pdf`,
    size: 2048,
    mimeType: 'application/pdf',
  });
});

test('resolveImageAssetFile resolves plain filenames inside the assets dir', () => {
  const resolved = resolveImageAssetFile('123-shot.png');
  assert.equal(resolved, path.join(path.resolve(ASSETS_DIR), '123-shot.png'));
});

test('resolveImageAssetFile rejects traversal and separator attempts', () => {
  assert.equal(resolveImageAssetFile(''), null);
  assert.equal(resolveImageAssetFile('   '), null);
  assert.equal(resolveImageAssetFile('../auth.db'), null);
  assert.equal(resolveImageAssetFile('..'), null);
  assert.equal(resolveImageAssetFile('sub/dir.png'), null);
  assert.equal(resolveImageAssetFile('sub\\dir.png'), null);
  assert.equal(resolveImageAssetFile('a..b/../c.png'), null);
});

test('resolveAttachmentAssetFile uses the same direct-child boundary', () => {
  assert.equal(
    resolveAttachmentAssetFile('123-notes.txt'),
    path.join(path.resolve(ASSETS_DIR), '123-notes.txt'),
  );
  assert.equal(resolveAttachmentAssetFile('../notes.txt'), null);
});
