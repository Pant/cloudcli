import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';
import { appConfigDb, closeConnection } from '@/modules/database/index.js';

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

test('browser startup backfills its managed MCP server into OpenCode when enabled', { concurrency: false }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'browser-mcp-opencode-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.HOME = tempDirectory;

  try {
    appConfigDb.set('browser_use_settings', JSON.stringify({ enabled: true }));

    const result = await browserUseService.initialize();
    const config = JSON.parse(
      await readFile(path.join(tempDirectory, '.config', 'opencode', 'opencode.json'), 'utf8'),
    ) as { mcp?: Record<string, { type?: string; command?: string[]; enabled?: boolean }> };

    assert.equal(result.enabled, true);
    assert.equal(result.registered, true);
    assert.equal(config.mcp?.['cloudcli-browser']?.type, 'local');
    assert.equal(config.mcp?.['cloudcli-browser']?.enabled, true);
    assert.ok(config.mcp?.['cloudcli-browser']?.command?.length);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
