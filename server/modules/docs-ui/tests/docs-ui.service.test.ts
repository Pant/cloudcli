import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';

import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

import { attachDocsUiWebSocketBridge, createDocsUiService, createDocsUiWebSocketBridge } from '@/modules/docs-ui/docs-ui.service.js';

async function withProxy(
  fetchImpl: typeof fetch,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  const proxy = createDocsUiService({
    upstreamUrl: 'http://fixed.internal/base/',
    credentialsFile: '/unused',
    overlayDirectory: new URL('../../../../../docs_mcp_server/overlay/', import.meta.url).pathname,
    loadAuthorization: async () => 'Basic server-owned',
    fetchImpl,
  });
  app.use('/api/docs-ui', (request, response, next) => void proxy(request, response).catch(next));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('uses only the fixed origin, strips identity headers, injects Basic, and forwards request bodies', async () => {
  let called = false;
  await withProxy(async (input, init) => {
    called = true;
    assert.equal(String(input), 'http://fixed.internal/base/upload?q=1');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Basic server-owned');
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.has('x-forwarded-for'), false);
    assert.equal(await new Response(init?.body).text(), 'payload');
    return new Response(Uint8Array.from([0, 1, 255]), { headers: { 'content-type': 'application/octet-stream' } });
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/docs-ui/upload?q=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer browser-token', cookie: 'private=1', 'x-forwarded-for': 'evil' },
      body: 'payload',
    });
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([0, 1, 255]));
  });
  assert.equal(called, true);
});

test('rewrites HTML resources, same-origin redirects and cookie scope while permitting framing', async () => {
  await withProxy(async () => new Response(
    '<script src="/assets/app.js"></script><script src="/assets/query.js?mode=prod#entry"></script><link rel="modulepreload" href="/assets/module.mjs?cloudcli-rev=existing"><link href="/assets/app.css"><form action="/api/search"></form><a href="http://fixed.internal/api/x">x</a><script src="/api/docs-ui/assets/already.js"></script><script>const asset="/assets/chunk.js";const api=`/api/query`;const existing="/api/docs-ui/assets/existing.js";</script>',
    { status: 302, headers: { 'content-type': 'text/html', location: '/login', 'set-cookie': 'sid=x; Domain=fixed.internal; Path=/', etag: 'upstream', 'last-modified': 'yesterday', digest: 'stale', 'accept-ranges': 'bytes', 'content-length': '999' } },
  ), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/docs-ui/`, { redirect: 'manual' });
    const html = await response.text();
    assert.match(html, /^<link rel="stylesheet" href="\/api\/docs-ui\/\.cloudcli\/docs-responsive\/docs-responsive\.css"/);
    assert.match(html, /<script src="\/api\/docs-ui\/\.cloudcli\/docs-responsive\/docs-responsive\.js" data-cloudcli-docs-responsive defer><\/script>/);
    assert.equal(html.match(/data-cloudcli-docs-responsive/g)?.length, 2);
    assert.match(html, /<script src="\/api\/docs-ui\/assets\/app\.js\?cloudcli-rev=docs-runtime-v2"><\/script>/);
    assert.doesNotMatch(html, /\/api\/docs-ui\/api\/docs-ui\//);
    assert.equal(html.match(/\/api\/docs-ui\/assets\/app\.js/g)?.length, 1);
    assert.equal(html.match(/cloudcli-rev=existing/g)?.length, 1);
    assert.equal(response.headers.get('location'), '/api/docs-ui/login');
    assert.match(response.headers.get('set-cookie') ?? '', /sid=x; Path=\/api\/docs-ui\//);
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
    assert.equal(response.headers.has('x-frame-options'), false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const header of ['etag', 'last-modified', 'digest', 'accept-ranges']) assert.equal(response.headers.has(header), false);
  });
});

test('serves only exact shared responsive overlay assets with bounded cache and MIME headers', async () => {
  let calls = 0;
  await withProxy(async () => { calls += 1; return new Response('upstream'); }, async (baseUrl) => {
    for (const [filename, contentType] of [['docs-responsive.css', 'text/css; charset=utf-8'], ['docs-responsive.js', 'application/javascript; charset=utf-8']]) {
      const response = await fetch(`${baseUrl}/api/docs-ui/.cloudcli/docs-responsive/${filename}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), contentType);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=300, immutable');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.doesNotMatch(await response.text(), /home\/dev\/code|authorization|password/i);
    }
    const rejected = await fetch(`${baseUrl}/api/docs-ui/.cloudcli/docs-responsive/unknown.js`);
    assert.equal(rejected.status, 502);
  });
  assert.equal(calls, 0);
});

test('rejects traversal, network-path targets and upstream failures with bounded secret-free errors', async () => {
  let calls = 0;
  await withProxy(async () => { calls += 1; throw new Error('credential secret internal failure'); }, async (baseUrl) => {
    for (const path of ['/api/docs-ui/%2e%2e%2fescape', '/api/docs-ui/%2f%2fevil.test/path', '/api/docs-ui/valid']) {
      const response = await fetch(`${baseUrl}${path}`);
      const text = await response.text();
      assert.equal(response.status, 502);
      assert.match(text, /DOCS_UI_UNAVAILABLE/);
      assert.doesNotMatch(text, /credential|secret|fixed\.internal/i);
    }
  });
  assert.equal(calls, 2);
});

test('rewrites JavaScript runtime origins to the Docs API prefix idempotently', async () => {
  await withProxy(async (_input, init) => {
    const headers = new Headers(init?.headers);
    for (const header of ['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range']) {
      assert.equal(headers.has(header), false);
    }
    return new Response(
    'const http=window.location.origin+"/api";const ws=`${window.location.origin}/api`;const existing=(window.location.origin+\'/api/docs-ui\');',
    { headers: { 'content-type': 'application/javascript', etag: 'upstream', 'last-modified': 'yesterday', 'content-digest': 'stale' } });
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/docs-ui/assets/app.js`, { headers: {
      'if-none-match': 'cached', 'if-modified-since': 'yesterday', 'if-match': 'old',
      'if-unmodified-since': 'today', 'if-range': 'range-validator',
    } });
    const source = await response.text();
    assert.equal(source.match(/window\.location\.origin\+'\/api\/docs-ui'/g)?.length, 3);
    assert.match(source, /existing=\(window\.location\.origin\+'\/api\/docs-ui'\)/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const header of ['etag', 'last-modified', 'content-digest', 'content-length']) assert.equal(response.headers.has(header), false);
  });
});

test('Docs websocket bridge authenticates its route, fixes the target, replaces credentials, and bridges frames', async () => {
  const upstreamServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(upstreamServer, 'listening');
  const upstreamPort = (upstreamServer.address() as AddressInfo).port;
  let upstreamRequest: import('node:http').IncomingMessage | undefined;
  let upstreamClient: WebSocket | undefined;
  upstreamServer.on('connection', (socket, request) => {
    upstreamClient = socket;
    upstreamRequest = request;
    socket.on('message', (data) => socket.send(`upstream:${data.toString()}`));
  });

  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  attachDocsUiWebSocketBridge(server, createDocsUiWebSocketBridge({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/fixed/`,
    credentialsFile: '/unused',
    loadAuthorization: async () => 'Basic server-owned',
    authenticateToken: (token) => token === 'valid',
  }));
  const port = (server.address() as AddressInfo).port;

  try {
    const rejected = new WebSocket(`ws://127.0.0.1:${port}/api/docs-ui/api`);
    const [error] = await once(rejected, 'error');
    assert.match(String(error), /401/);

    const client = new WebSocket(`ws://127.0.0.1:${port}/api/docs-ui/api`, {
      headers: { cookie: 'cloudcli-docs-token=valid; private=browser', authorization: 'Bearer browser' },
    });
    await once(client, 'open');
    client.send('hello');
    const [message] = await once(client, 'message');
    assert.equal(message.toString(), 'upstream:hello');
    assert.equal(upstreamRequest?.url, '/fixed/api');
    assert.equal(upstreamRequest?.headers.authorization, 'Basic server-owned');
    assert.equal(upstreamRequest?.headers.cookie, undefined);
    client.close();
  } finally {
    upstreamClient?.terminate();
    for (const client of upstreamServer.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test('Docs websocket bridge leaves unrelated upgrade routes untouched', async () => {
  const bridge = createDocsUiWebSocketBridge({
    upstreamUrl: 'http://fixed.internal/', credentialsFile: '/unused',
    authenticateToken: () => true, loadAuthorization: async () => 'Basic fixed',
  });
  const handled = await bridge({ url: '/ws', headers: {} } as import('node:http').IncomingMessage,
    {} as import('node:stream').Duplex, Buffer.alloc(0));
  assert.equal(handled, false);
});

test('Docs websocket bridge tears down an upstream connection still opening when the client closes', async () => {
  const stalledConnections = new Set<import('node:net').Socket>();
  const stalledServer = createNetServer((socket) => {
    stalledConnections.add(socket);
    socket.on('close', () => stalledConnections.delete(socket));
  }).listen(0, '127.0.0.1');
  await once(stalledServer, 'listening');
  const upstream = new WebSocket(`ws://127.0.0.1:${(stalledServer.address() as AddressInfo).port}`);
  upstream.on('error', () => undefined);
  const bridge = createDocsUiWebSocketBridge({
    upstreamUrl: 'http://fixed.internal/', credentialsFile: '/unused',
    authenticateToken: () => true, loadAuthorization: async () => 'Basic fixed',
    createUpstream: () => upstream,
  });
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  attachDocsUiWebSocketBridge(server, bridge);
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/docs-ui/api`, {
    headers: { cookie: 'cloudcli-docs-token=valid' },
  });
  await once(client, 'open');
  client.close();
  await once(client, 'close');
  assert.equal(upstream.readyState, WebSocket.CLOSED);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const socket of stalledConnections) socket.destroy();
  await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
});
