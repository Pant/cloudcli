import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { configureDynamicResponseCaching, createRequestCompletionDiagnostic, resolveRequestId, shouldLogRequestCompletion } from '../utils.js';

test('accepts safe request IDs and replaces unsafe values', () => {
  assert.equal(resolveRequestId('client-id_1'), 'client-id_1');
  assert.match(resolveRequestId('bad id\nvalue'), /^[0-9a-f-]{36}$/i);
});

test('completion diagnostic omits query values and classifies outcome', () => {
  const diagnostic = createRequestCompletionDiagnostic({ requestId: 'r1', method: 'GET', path: '/api/x?token=secret', status: 503, durationMs: 12.6 });
  assert.equal(diagnostic.path, '/api/x');
  assert.equal(diagnostic.outcome, 'server_error');
  assert.equal(diagnostic.durationMs, 13);
  assert.equal(JSON.stringify(diagnostic).includes('secret'), false);
});

test('request logging omits routine cache validation but keeps redirects and errors', () => {
  assert.equal(shouldLogRequestCompletion(304), false);
  assert.equal(shouldLogRequestCompletion(303), true);
  assert.equal(shouldLogRequestCompletion(200), true);
  assert.equal(shouldLogRequestCompletion(503), true);
});

test('dynamic responses omit implicit ETags while static assets retain cache validation', async () => {
  const app = express();
  configureDynamicResponseCaching(app);
  app.get('/api/state', (_request, response) => response.json({ state: 'ready' }));
  app.use('/static', express.static('public'));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const dynamicResponse = await fetch(`http://127.0.0.1:${address.port}/api/state`);
    assert.equal(dynamicResponse.status, 200);
    assert.equal(dynamicResponse.headers.get('etag'), null);
    assert.equal(dynamicResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await dynamicResponse.json(), { state: 'ready' });

    const staticResponse = await fetch(`http://127.0.0.1:${address.port}/static/manifest.json`);
    assert.equal(staticResponse.status, 200);
    assert.notEqual(staticResponse.headers.get('etag'), null);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
