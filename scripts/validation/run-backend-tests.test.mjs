import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBackendTestMembership, backendTestPartitions, parseTapCounts } from './run-backend-tests.mjs';

test('audited partitions list every emitted backend test exactly once', async () => {
  const listed = backendTestPartitions.flat();
  assert.equal(new Set(listed).size, listed.length);
  assert.equal(await auditBackendTestMembership(), listed.length);
});

test('partition TAP summaries aggregate exact result counts', () => {
  assert.deepEqual(parseTapCounts('# tests 42\n# pass 40\n# fail 1\n# skipped 1\n'), { tests: 42, passed: 40, failed: 1, skipped: 1 });
});
