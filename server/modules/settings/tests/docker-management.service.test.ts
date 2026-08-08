import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createDockerManagementService } from '../docker-management.service.js';

function service(fetchImplementation: typeof fetch, overrides: Record<string, unknown> = {}) {
  return createDockerManagementService({
    baseUrl: 'https://management.code.pantelis.ninja/',
    credentialsFile: '/trusted/credentials',
    timeoutMs: 100,
    fetch: fetchImplementation,
    readFile: async () => 'username: server-user\npassword: server-password\n',
    ...overrides,
  });
}

test('uses fixed action URLs, POST, and server-side Basic Auth only', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const client = service(async (url, init) => {
    calls.push([String(url), init]);
    return new Response(null, { status: 202 });
  });
  await client.trigger('build');
  await client.trigger('restart');
  await client.trigger('down');
  assert.deepEqual(calls.map(([url]) => url), [
    'https://management.code.pantelis.ninja/api/build',
    'https://management.code.pantelis.ninja/api/up',
    'https://management.code.pantelis.ninja/api/down',
  ]);
  assert.equal(calls[0]?.[1]?.method, 'POST');
  assert.equal((calls[0]?.[1]?.headers as Record<string, string>).Authorization,
    `Basic ${Buffer.from('server-user:server-password').toString('base64')}`);
  assert.equal(calls[0]?.[1]?.body, undefined);
});

test('returns after headers and drains the body asynchronously', async () => {
  let release!: () => void;
  let drained = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      release = () => { drained = true; controller.close(); };
    },
  });
  const client = service(async () => new Response(body, { status: 200 }));
  await client.trigger('build');
  assert.equal(drained, false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, true);
});

test('maps immediate upstream and configuration failures to stable AppErrors', async () => {
  for (const [status, code, cloudStatus] of [
    [401, 'DOCKER_MANAGEMENT_AUTH_FAILED', 502],
    [403, 'DOCKER_MANAGEMENT_AUTH_FAILED', 502],
    [409, 'DOCKER_MANAGEMENT_CONFLICT', 409],
    [500, 'DOCKER_MANAGEMENT_UPSTREAM_ERROR', 502],
  ] as const) {
    await assert.rejects(service(async () => new Response(null, { status })).trigger('build'),
      (error: AppError) => error.code === code && error.statusCode === cloudStatus);
  }
  await assert.rejects(service(async () => new Response(null), {
    credentialsFile: undefined, username: undefined, password: undefined,
  }).trigger('build'), (error: AppError) => error.code === 'DOCKER_MANAGEMENT_NOT_CONFIGURED');
  await assert.rejects(service(async () => { throw new Error('secret network detail'); }).trigger('build'),
    (error: AppError) => error.code === 'DOCKER_MANAGEMENT_UNAVAILABLE'
      && !error.message.includes('secret'));
});

test('maps request timeout without invoking a live endpoint', async () => {
  const client = service((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }), { timeoutMs: 1 });
  await assert.rejects(client.trigger('restart'),
    (error: AppError) => error.code === 'DOCKER_MANAGEMENT_TIMEOUT' && error.statusCode === 504);
});
