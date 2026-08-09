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

test('history exposes revision/ETag, supports conditional full history, and preserves pagination', { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'history-route-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db'); await initializeDatabase();
  sessionsDb.createAppSession('empty-history', 'claude', '/workspace');
  const revision = sessionsDb.getSessionById('empty-history')!.updated_at;
  const app = express(); app.use('/api/providers', providerRoutes); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/api/providers/sessions/empty-history/messages`);
    const payload = await response.json() as { protocolVersion: number; data: { revision: string; messages: unknown[]; limit: null } };
    assert.equal(payload.protocolVersion, 1); assert.equal(payload.data.revision, revision); assert.deepEqual(payload.data.messages, []);
    assert.equal(response.headers.get('etag'), `"${revision}"`);
    const conditional = await fetch(`${base}/api/providers/sessions/empty-history/messages`, { headers: { 'If-None-Match': `W/"other", W/"${revision}"` } });
    assert.equal(conditional.status, 304); assert.equal(await conditional.text(), '');
    const paged = await fetch(`${base}/api/providers/sessions/empty-history/messages?limit=20&offset=0`, { headers: { 'If-None-Match': `"${revision}"` } });
    assert.equal(paged.status, 200); assert.equal((await paged.json() as { data: { limit: number } }).data.limit, 20);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
