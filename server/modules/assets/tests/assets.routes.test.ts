import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import sharp from 'sharp';

import assetsRoutes from '@/modules/assets/assets.routes.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';

async function withAssetsServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/api/assets', (request, response, next) => {
    if (request.headers.authorization !== 'Bearer allowed') return response.status(401).json({ error: 'Unauthorized' });
    return next();
  }, assetsRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('thumbnail and original routes remain authenticated and preserve original bytes', async () => {
  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  const filename = `route-thumbnail-${process.pid}.png`;
  const assetPath = path.join(assetsDir, filename);
  const original = await sharp({ create: { width: 900, height: 500, channels: 3, background: '#7542a8' } }).png().toBuffer();
  await fs.writeFile(assetPath, original);
  try {
    await withAssetsServer(async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/api/assets/images/${filename}/thumbnail`)).status, 401);
      assert.equal((await fetch(`${baseUrl}/api/assets/images/${filename}`)).status, 401);

      const thumbnail = await fetch(`${baseUrl}/api/assets/images/${filename}/thumbnail`, { headers: { Authorization: 'Bearer allowed' } });
      assert.equal(thumbnail.status, 200);
      assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
      assert.equal(thumbnail.headers.get('x-content-type-options'), 'nosniff');
      const metadata = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
      assert.ok((metadata.width || 0) <= 224);
      assert.ok((metadata.height || 0) <= 224);

      const response = await fetch(`${baseUrl}/api/assets/images/${filename}`, { headers: { Authorization: 'Bearer allowed' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    });
  } finally {
    await fs.rm(assetPath, { force: true });
  }
});

test('thumbnail route reports invalid, missing, and unsupported assets without changing originals', async () => {
  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  const filename = `route-thumbnail-${process.pid}.svg`;
  const assetPath = path.join(assetsDir, filename);
  const original = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  await fs.writeFile(assetPath, original);
  try {
    await withAssetsServer(async (baseUrl) => {
      const headers = { Authorization: 'Bearer allowed' };
      assert.equal((await fetch(`${baseUrl}/api/assets/images/%2E%2E%2E/thumbnail`, { headers })).status, 400);
      assert.equal((await fetch(`${baseUrl}/api/assets/images/missing-${process.pid}.png/thumbnail`, { headers })).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/assets/images/${filename}/thumbnail`, { headers })).status, 415);
      const response = await fetch(`${baseUrl}/api/assets/images/${filename}`, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-disposition'), 'attachment');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    });
  } finally {
    await fs.rm(assetPath, { force: true });
  }
});
