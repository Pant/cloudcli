import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, mutationReceiptsDb } from '../index.js';

test('mutation receipts claim, conflict, complete, replay, expire, and clean up', { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mutation-receipts-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db'); await initializeDatabase();
  try {
    const base = { scope: 'user:1', operation: 'rename', key: 'key', fingerprint: 'fp', now: 100, ttlMs: 100 };
    assert.deepEqual(mutationReceiptsDb.claim(base), { kind: 'claimed' });
    assert.deepEqual(mutationReceiptsDb.claim(base), { kind: 'in_progress' });
    assert.deepEqual(mutationReceiptsDb.claim({ ...base, fingerprint: 'different' }), { kind: 'fingerprint_conflict' });
    assert.equal(mutationReceiptsDb.complete({ ...base, result: { httpStatus: 200, payload: { sessionId: 's' } } }), true);
    assert.deepEqual(mutationReceiptsDb.claim(base), { kind: 'completed', result: { httpStatus: 200, payload: { sessionId: 's' } } });
    assert.deepEqual(mutationReceiptsDb.claim({ ...base, key: 'expired', now: 0, ttlMs: 1 }), { kind: 'claimed' });
    assert.ok(mutationReceiptsDb.cleanup({ now: 2, maxRows: 1 }) >= 1);
  } finally {
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
