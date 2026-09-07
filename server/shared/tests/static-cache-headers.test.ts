import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { configureDynamicResponseCaching, createPwaCompatibilityResourceHandler, setStaticResourceCacheHeaders } from '@/shared/utils.js';

async function exerciseLayout(layout: 'source' | 'source-plus-built'): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.homedir(), `.cloudcli-static-${layout}-`));
  const publicRoot = path.join(root, 'public');
  const distRoot = path.join(root, 'dist');
  await fs.mkdir(path.join(publicRoot, 'icons'), { recursive: true });
  await fs.mkdir(path.join(distRoot, 'assets'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(distRoot, 'index.html'), '<!doctype html><title>CloudCLI</title>'),
    fs.writeFile(path.join(distRoot, 'assets', 'app-12345678.js'), 'export{}'),
    fs.writeFile(path.join(distRoot, 'manifest.json'), '{}'),
    fs.writeFile(path.join(distRoot, 'cloudcli-version.json'), '{"build":"test-build"}'),
    fs.writeFile(path.join(publicRoot, 'icons', 'icon.png'), 'icon'),
    fs.writeFile(path.join(publicRoot, 'sw.js'), 'source-worker-__CLOUDCLI_SHELL__'),
    ...(layout === 'source-plus-built' ? [fs.writeFile(path.join(distRoot, 'sw.js'), 'built-worker-["index.html"]')] : []),
  ]);

  const app = express();
  configureDynamicResponseCaching(app);
  app.get('/api/probe', (_request, response) => response.json({ ok: true }));
  app.use(express.static(distRoot, { setHeaders: setStaticResourceCacheHeaders }));
  app.use(express.static(publicRoot, { setHeaders: setStaticResourceCacheHeaders }));
  app.use('/prefix', express.static(distRoot, { setHeaders: setStaticResourceCacheHeaders }));
  app.get('/{*routePath}', createPwaCompatibilityResourceHandler(root));
  app.get('/{*routePath}', (_request, response) => {
    if (path.extname(_request.path)) return response.status(404).send('Not found');
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    response.sendFile(path.join(distRoot, 'index.html'), (error) => {
      if (error && !response.headersSent) response.status(500).end();
    });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const [worker, manifest, icon, html, asset, api, version, prefixedVersion, nestedWorker, nestedManifest, nestedVersion, unrelatedExtension] = await Promise.all([
      fetch(`${base}/sw.js`),
      fetch(`${base}/manifest.json`),
      fetch(`${base}/icons/icon.png`),
      fetch(`${base}/session/deep-link`),
      fetch(`${base}/assets/app-12345678.js`),
      fetch(`${base}/api/probe`),
      fetch(`${base}/cloudcli-version.json`),
      fetch(`${base}/prefix/cloudcli-version.json`),
      fetch(`${base}/session/sw.js`),
      fetch(`${base}/project/deep/manifest.json`),
      fetch(`${base}/session/cloudcli-version.json`),
      fetch(`${base}/session/unrelated.json`),
    ]);
    assert.doesNotMatch(worker.headers.get('cache-control') ?? '', /immutable/);
    const expectedWorkerBody = layout === 'source' ? 'source-worker-__CLOUDCLI_SHELL__' : 'built-worker-["index.html"]';
    assert.equal(await worker.text(), expectedWorkerBody);
    assert.match(manifest.headers.get('cache-control') ?? '', /no-cache/);
    assert.match(icon.headers.get('cache-control') ?? '', /no-cache/);
    assert.equal(html.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await version.json(), { build: 'test-build' });
    assert.equal(version.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
    assert.equal(prefixedVersion.status, 200);
    assert.deepEqual(await nestedVersion.json(), { build: 'test-build' });
    assert.match(nestedWorker.headers.get('cache-control') ?? '', /no-cache/);
    assert.equal(await nestedWorker.text(), expectedWorkerBody);
    assert.match(nestedManifest.headers.get('cache-control') ?? '', /no-cache/);
    assert.match(nestedVersion.headers.get('cache-control') ?? '', /no-cache/);
    assert.equal(unrelatedExtension.status, 404);
    await Promise.all([manifest.text(), icon.text(), html.text(), asset.text(), api.text(), prefixedVersion.text(), nestedManifest.text(), unrelatedExtension.text()]);
  } finally {
    server.close();
    await once(server, 'close');
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('source static layout applies resource-role cache policies', () => exerciseLayout('source'));
test('source-plus-built static layout serves the processed worker', () => exerciseLayout('source-plus-built'));
