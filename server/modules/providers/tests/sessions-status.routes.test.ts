import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionRunStateDb, sessionsDb } from '@/modules/database/index.js';
import providerRoutes from '@/modules/providers/provider.routes.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { closeSessionsWatcher } from '@/modules/providers/services/sessions-watcher.service.js';
import { reconcileInterruptedOpenCodeRuns } from '@/modules/websocket/index.js';

test('static session status route returns canonical lifecycle rows', { concurrency: false }, async () => {
  const previous = process.env.DATABASE_PATH;
  const previousHome = os.homedir;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sessions-status-route-'));
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-status-home-'));
  (os as any).homedir = () => homeDirectory;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  sessionsDb.createAppSession('canonical-status', 'opencode', '/workspace/status-route');
  sessionsDb.assignProviderSessionId('canonical-status', 'native-status');
  const run = sessionRunStateDb.beginRun({ sessionId: 'canonical-status', provider: 'opencode', now: 10 });
  const originals = { health: providerRuntimeService.getHealth, children: providerRuntimeService.listChildActivity, approvals: providerRuntimeService.getPendingApprovalsForSession };
  providerRuntimeService.getHealth = () => ({ state: 'missing', startedAt: null, lastOutputAt: null, exitCode: null });
  providerRuntimeService.listChildActivity = () => [];
  providerRuntimeService.getPendingApprovalsForSession = () => [];
  reconcileInterruptedOpenCodeRuns({ now: () => 20 });

  const app = express();
  app.use('/api/providers', providerRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/providers/sessions/status`);
    const payload = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(payload.data.sessions[0].sessionId, 'canonical-status');
    assert.equal(payload.data.sessions[0].status, 'stalled');
    assert.equal(payload.data.sessions[0].restartable, true);
    assert.match(payload.data.sessions[0].statusText, /Restart/);
    assert.equal(JSON.stringify(payload).includes('native-status'), false);
  } finally {
    providerRuntimeService.getHealth = originals.health;
    providerRuntimeService.listChildActivity = originals.children;
    providerRuntimeService.getPendingApprovalsForSession = originals.approvals;
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeSessionsWatcher();
    (os as any).homedir = previousHome;
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
