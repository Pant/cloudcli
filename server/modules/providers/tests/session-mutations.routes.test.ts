import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '../../database/index.js';
import providerRoutes from '../provider.routes.js';
import { chatRunLifecycleService } from '../../websocket/index.js';

test('rename supports canonical replay, key conflicts, stale revisions, and legacy input', { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mutation-routes-')); const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db'); await initializeDatabase();
  sessionsDb.createAppSession('rename-test', 'claude', '/workspace');
  const revision = sessionsDb.getSessionById('rename-test')!.updated_at;
  const app = express(); app.use(express.json()); app.use('/api/providers', providerRoutes);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const value = error as { statusCode?: number; code?: string; message?: string; details?: unknown };
    res.status(value.statusCode ?? 500).json({ success: false, error: { code: value.code ?? 'ERROR', message: value.message ?? 'error', details: value.details } });
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (body: unknown, key?: string) => fetch(`${base}/api/providers/sessions/rename-test`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
  try {
    const first = await request({ summary: 'Canonical', expectedRevision: revision, clientMutationId: 'm1' }, 'k1');
    const firstPayload = await first.json() as { data: { summary: string; revision: string; clientMutationId: string } };
    assert.equal(first.status, 200); assert.equal(firstPayload.data.summary, 'Canonical'); assert.equal(firstPayload.data.clientMutationId, 'm1'); assert.notEqual(firstPayload.data.revision, revision);
    assert.deepEqual(await (await request({ summary: 'Canonical', expectedRevision: revision, clientMutationId: 'm1' }, 'k1')).json(), firstPayload);
    assert.equal((await request({ summary: 'Different' }, 'k1')).status, 409);
    const stale = await request({ summary: 'Stale', expectedRevision: revision }, 'k2');
    assert.equal(stale.status, 409); assert.equal(((await stale.json()) as { error: { code: string; details: { currentRevision: string } } }).error.code, 'SESSION_REVISION_CONFLICT');
    assert.equal((await request({ summary: 'Legacy' })).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())); closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; await rm(directory, { recursive: true, force: true });
  }
});

test('authenticated session start forwards request identity to the run lifecycle', { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mutation-start-route-')); const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db'); await initializeDatabase();
  sessionsDb.createAppSession('start-test', 'opencode', '/workspace');
  const original = chatRunLifecycleService.manualStart;
  let received: unknown;
  chatRunLifecycleService.manualStart = async (sessionId, userId) => { received = { sessionId, userId }; return { sessionId, provider: 'opencode', generation: 1 }; };
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as express.Request & { user: { id: number } }).user = { id: 73 }; next(); }); app.use('/api/providers', providerRoutes);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/api/providers/sessions/start-test/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 202);
    assert.deepEqual(received, { sessionId: 'start-test', userId: 73 });
  } finally {
    chatRunLifecycleService.manualStart = original;
    await new Promise<void>((resolve) => server.close(() => resolve())); closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; await rm(directory, { recursive: true, force: true });
  }
});
