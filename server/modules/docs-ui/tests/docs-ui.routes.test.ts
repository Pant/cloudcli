import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createDocsUiRouter } from '@/modules/docs-ui/docs-ui.routes.js';

test('session is bearer-only and catch-all preserves methods, paths, queries and proxy responses', async () => {
  const seen: string[] = [];
  const proxy: RequestHandler = (request, response) => {
    seen.push(`${request.method} ${request.originalUrl}`);
    response.status(206).set('x-proxy', 'yes').send('proxied');
  };
  const app = express();
  app.use('/api/docs-ui', createDocsUiRouter(proxy));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${baseUrl}/api/docs-ui/session`, { method: 'POST' })).status, 401);
    const session = await fetch(`${baseUrl}/api/docs-ui/session`, { method: 'POST', headers: { authorization: 'Bearer opaque' } });
    assert.equal(session.status, 204);
    assert.match(session.headers.get('set-cookie') ?? '', /^cloudcli-docs-token=opaque; Path=\/api\/docs-ui\/; HttpOnly; SameSite=Strict$/);
    const proxied = await fetch(`${baseUrl}/api/docs-ui/api/items?q=one`, { method: 'PUT', body: 'body' });
    assert.equal(proxied.status, 206);
    assert.equal(proxied.headers.get('x-proxy'), 'yes');
    assert.equal(await proxied.text(), 'proxied');
    assert.deepEqual(seen, ['PUT /api/docs-ui/api/items?q=one']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
