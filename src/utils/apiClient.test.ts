import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOUDCLI_PROTOCOL_VERSION, type SessionHistoryEnvelope } from '../../shared/cloudcli-contracts';
import { clearDiagnostics, exportDiagnostics } from '../lib/logger';

import { ApiClient, ApiError } from './apiClient';
import type { SessionHistoryValidationOptions } from './sessionHistoryValidation';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const eventTarget = new EventTarget();
Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'window', { value: eventTarget, configurable: true });
if (typeof globalThis.CustomEvent === 'undefined') {
  Object.defineProperty(globalThis, 'CustomEvent', { value: class<T> extends Event { detail: T; constructor(type: string, init: CustomEventInit<T>) { super(type); this.detail = init.detail as T; } } });
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const validHistory: SessionHistoryEnvelope = { protocolVersion: CLOUDCLI_PROTOCOL_VERSION, success: true, data: { revision: 'rev-1', messages: [], total: 0, hasMore: false, offset: 0, limit: null } };

test('sends conditional history revision and returns typed notModified', async () => {
  let ifNoneMatch: string | null = null;
  let cacheMode: RequestCache | undefined;
  const client = new ApiClient(async (_url, init) => {
    ifNoneMatch = new Headers(init?.headers).get('If-None-Match');
    cacheMode = init?.cache;
    return new Response(null, { status: 304, headers: { ETag: 'W/"rev-1"' } });
  });
  assert.deepEqual(await client.sessionHistory('s', { revision: 'rev-1' }), { notModified: true, revision: 'rev-1' });
  assert.equal(ifNoneMatch, '"rev-1"');
  assert.equal(cacheMode, 'no-store');
});

test('unconditional session history bypasses the implicit browser HTTP cache', async () => {
  let cacheMode: RequestCache | undefined;
  const client = new ApiClient(async (_url, init) => {
    cacheMode = init?.cache;
    return jsonResponse(validHistory);
  });
  await client.sessionHistory('s');
  assert.equal(cacheMode, 'no-store');
});

test('awaits asynchronous validation for concurrent unconditional and conditional history bodies', async () => {
  const releases: Array<() => void> = [];
  let active = 0;
  let maximum = 0;
  const parser = async (_input: unknown) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return { ok: true as const, value: validHistory };
  };
  const client = new ApiClient(async () => jsonResponse(validHistory), parser);
  const first = client.sessionHistory('first');
  const second = client.sessionHistory('second', { revision: 'old' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  releases.splice(0).forEach((release) => release());
  const results = await Promise.all([first, second]);
  assert.equal(maximum, 2);
  assert.ok(results.every((result) => !result.notModified && result.revision === 'rev-1'));
});

test('maps deterministic asynchronous history validation failures to contract errors', async () => {
  const malformed = { ...validHistory, data: { ...validHistory.data, messages: [{ id: '', sessionId: 's', timestamp: '2026-08-09T00:00:00Z', provider: 'claude', kind: 'text', content: 'bad' }], total: 1 } };
  const client = new ApiClient(async () => jsonResponse(malformed));
  await assert.rejects(client.sessionHistory('s'), (error: ApiError) => error.code === 'CONTRACT_ERROR' && error.message === '$.data.messages[0].id must be a non-empty string.');
});

test('caller abort during asynchronous history validation rejects as aborted', async () => {
  const parser = (_input: unknown, options?: SessionHistoryValidationOptions) => new Promise<never>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const client = new ApiClient(async () => jsonResponse(validHistory), parser);
  const controller = new AbortController();
  const pending = client.sessionHistory('s', { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error: ApiError) => error.code === 'ABORTED');
});

test('conditional 304 does not parse a body or schedule history validation', async () => {
  let parses = 0;
  const client = new ApiClient(async () => {
    const response = new Response(null, { status: 304, headers: { ETag: '"rev-2"' } });
    Object.defineProperty(response, 'json', { value: () => { throw new Error('body parsed'); } });
    return response;
  }, async () => { parses += 1; return { ok: true, value: validHistory }; });
  assert.deepEqual(await client.sessionHistory('s', { revision: 'rev-1' }), { notModified: true, revision: 'rev-2' });
  assert.equal(parses, 0);
});

test('generates request IDs, sends auth, and accepts server request IDs', async () => {
  localStorage.setItem('auth-token', 'a.b.c');
  let headers: Headers | undefined;
  const client = new ApiClient(async (_url, init) => { headers = new Headers(init?.headers); return jsonResponse(validHistory, 200, { 'X-Request-ID': 'server-id' }); });
  await client.sessionHistory('s');
  assert.match(headers?.get('X-Request-ID') ?? '', /.+/);
  assert.equal(headers?.get('Authorization'), 'Bearer a.b.c');
});

test('distinguishes caller abort from timeout', async () => {
  const client = new ApiClient((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
  const controller = new AbortController();
  const aborted = client.sessionHistory('s', { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, (error: ApiError) => error.code === 'ABORTED');
  await assert.rejects(client.sessionHistory('s', { timeoutMs: 1 }), (error: ApiError) => error.code === 'TIMEOUT');
});

test('safe GET retries once for transport and transient status failures', async () => {
  let calls = 0;
  const client = new ApiClient(async () => { calls += 1; if (calls === 1) throw new TypeError('offline'); return jsonResponse(validHistory); });
  await client.sessionHistory('s');
  assert.equal(calls, 2);
  calls = 0;
  const transient = new ApiClient(async () => { calls += 1; return calls === 1 ? jsonResponse({ success: false, error: { code: 'BUSY', message: 'busy' } }, 503) : jsonResponse(validHistory); });
  await transient.sessionHistory('s');
  assert.equal(calls, 2);
});

test('contract failures and ordinary 4xx do not retry', async () => {
  let calls = 0;
  const client = new ApiClient(async () => { calls += 1; return jsonResponse({ success: true, data: {} }); });
  await assert.rejects(client.sessionHistory('s'), (error: ApiError) => error.code === 'CONTRACT_ERROR');
  assert.equal(calls, 1);
});

test('unsafe writes do not retry and carry explicit idempotency keys', async () => {
  let calls = 0;
  let idempotencyKey: string | null = null;
  const client = new ApiClient(async (_url, init) => { calls += 1; idempotencyKey = new Headers(init?.headers).get('Idempotency-Key'); throw new TypeError('offline'); });
  await assert.rejects(client.renameSession('s', 'name', {}, { idempotencyKey: 'key-1' }), (error: ApiError) => error.code === 'NETWORK_ERROR');
  assert.equal(calls, 1);
  assert.equal(idempotencyKey, 'key-1');
});

test('mutation methods send stable metadata and parse canonical responses/conflict details', async () => {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const client = new ApiClient(async (url, init) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (String(url).endsWith('/start')) return jsonResponse({ success: true, data: { sessionId: 's', provider: 'claude', generation: 2, clientMutationId: 'm1' } }, 202);
    return jsonResponse({ success: true, data: { sessionId: 's', summary: 'Name', revision: 'rev-2', clientMutationId: 'm2' } });
  });
  assert.equal((await client.startSession('s', { clientMutationId: 'm1' }, { idempotencyKey: 'k1' })).generation, 2);
  assert.equal((await client.renameSession('s', 'Name', { clientMutationId: 'm2', expectedRevision: 'rev-1' }, { idempotencyKey: 'k2' })).revision, 'rev-2');
  assert.equal(requests[0].headers.get('Idempotency-Key'), 'k1');
  assert.deepEqual(requests[1].body, { summary: 'Name', clientMutationId: 'm2', expectedRevision: 'rev-1' });

  const conflictClient = new ApiClient(async () => jsonResponse({ success: false, error: { code: 'SESSION_REVISION_CONFLICT', message: 'stale', details: { currentRevision: 'rev-2', session: { sessionId: 's' } } } }, 409));
  await assert.rejects(conflictClient.renameSession('s', 'Name'), (error: ApiError) => error.code === 'SESSION_REVISION_CONFLICT' && (error.details as { currentRevision: string }).currentRevision === 'rev-2');
});

test('refresh and expiration response headers preserve auth events', async () => {
  const events: string[] = [];
  window.addEventListener('auth-token-refreshed', () => events.push('refresh'));
  window.addEventListener('auth-session-expired', () => events.push('expired'));
  const token = 'eyJhbGciOiJub25lIn0.eyJpYXQiOjEsImV4cCI6OTk5OTk5OTk5OX0.sig';
  const client = new ApiClient(async () => jsonResponse(validHistory, 200, { 'X-Refreshed-Token': token, 'X-Auth-Error': 'expired' }));
  await client.sessionHistory('s');
  assert.deepEqual(events, ['refresh', 'expired']);
  assert.equal(localStorage.getItem('auth-token'), null);
});

test('emits correlated request lifecycle diagnostics without query values', async () => {
  clearDiagnostics();
  const client = new ApiClient(async () => jsonResponse(validHistory));
  await client.sessionHistory('sensitive-session', { requestId: 'timeline-1', limit: 10, offset: 20 });
  const bundle = JSON.parse(exportDiagnostics());
  const requestEvents = bundle.events.filter((event: { area: string }) => event.area === 'api');
  assert.deepEqual(requestEvents.map((event: { event: string }) => event.event), ['request_started', 'request_succeeded']);
  assert.ok(requestEvents.every((event: { requestId: string }) => event.requestId === 'timeline-1'));
  assert.equal(JSON.stringify(requestEvents).includes('offset=20'), false);
  assert.equal(requestEvents[0].metadata.route, '/api/providers/sessions/:sessionId/messages');
});
