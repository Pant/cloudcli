import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import providerRoutes from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: (baseUrl: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-manifest-route-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const app = express();
  app.use('/api/providers', providerRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code });
      return;
    }

    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await runTest(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session manifest route returns one metadata-only row for active and archived sessions', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (baseUrl) => {
    sessionsDb.createSession(
      'manifest-active',
      'claude',
      '/workspace/manifest-route',
      undefined,
      '2025-02-01T00:00:00.000Z',
      '2025-02-02T00:00:00.000Z',
      '/must-not-be-read/active.jsonl',
    );
    sessionsDb.createSession(
      'manifest-archived',
      'cursor',
      '/workspace/manifest-route',
      undefined,
      '2025-02-03T00:00:00.000Z',
      '2025-02-04T00:00:00.000Z',
      '/must-not-be-read/archived.jsonl',
    );
    sessionsDb.updateSessionIsArchived('manifest-archived', true);
    sessionsDb.createAppSession('manifest-pending', 'opencode', '/workspace/manifest-route');

    const response = await fetch(`${baseUrl}/api/providers/sessions/manifest`);
    const payload = await response.json() as {
      success: boolean;
      data: {
        sessions: Array<{
          sessionId: string;
          provider: string;
          revision: string;
          isArchived: boolean;
          historyReady: boolean;
        }>;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data.sessions.map((session) => session.sessionId).sort(), [
      'manifest-active',
      'manifest-archived',
      'manifest-pending',
    ]);
    assert.deepEqual(payload.data.sessions.find((session) => session.sessionId === 'manifest-active'), {
      sessionId: 'manifest-active',
      provider: 'claude',
      revision: '2025-02-02T00:00:00.000Z',
      isArchived: false,
      historyReady: true,
    });
    assert.deepEqual(payload.data.sessions.find((session) => session.sessionId === 'manifest-archived'), {
      sessionId: 'manifest-archived',
      provider: 'cursor',
      revision: '2025-02-04T00:00:00.000Z',
      isArchived: true,
      historyReady: true,
    });
    assert.equal(
      payload.data.sessions.find((session) => session.sessionId === 'manifest-pending')?.historyReady,
      false,
    );
  });
});

test('static session manifest route is resolved before the generic session id route', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions/manifest`);
    const payload = await response.json() as { success: boolean; data: { sessions: unknown[] } };

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data.sessions, []);
  });
});
