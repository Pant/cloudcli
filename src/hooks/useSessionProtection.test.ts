import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionLifecycleSnapshot } from '../types/app';

import { reconcileLifecycleSnapshots, reconcileProcessingSnapshots } from './useSessionProtection';

const snapshot = (sessionId: string, status: SessionLifecycleSnapshot['status']): SessionLifecycleSnapshot => ({
  sessionId,
  provider: 'opencode',
  session: { id: sessionId, provider: 'opencode' },
  project: null,
  status,
  lastActivityAt: 1,
  restartable: !['running', 'recovering'].includes(status),
  canInterrupt: ['running', 'recovering'].includes(status),
});

test('lifecycle polling is authoritative and retains terminal rows separately from activity', () => {
  const first = reconcileLifecycleSnapshots([snapshot('running', 'running'), snapshot('failed', 'failed')]);
  assert.deepEqual([...first.keys()], ['running', 'failed']);
  assert.equal(first.get('failed')?.restartable, true);

  const next = reconcileLifecycleSnapshots([snapshot('running', 'recovering')]);
  assert.deepEqual([...next.keys()], ['running']);
  assert.equal(next.get('running')?.status, 'recovering');
});

test('duplicate and stale lifecycle rows resolve to the latest authoritative snapshot', () => {
  const reconciled = reconcileLifecycleSnapshots([
    snapshot('child', 'stalled'),
    snapshot('child', 'running'),
  ]);
  assert.equal(reconciled.size, 1);
  assert.equal(reconciled.get('child')?.status, 'running');
});

test('authoritative terminal omission removes activity promptly while local-start grace remains', () => {
  const authoritative = new Map([['done', { startedAt: 1, statusText: null, canInterrupt: true, locallyStarted: false }]]);
  assert.equal(reconcileProcessingSnapshots(authoritative, [], 2).has('done'), false);

  const local = new Map([['starting', { startedAt: 100, statusText: null, canInterrupt: true, locallyStarted: true }]]);
  assert.equal(reconcileProcessingSnapshots(local, [], 101).has('starting'), true);
  assert.equal(reconcileProcessingSnapshots(local, [], 10_101).has('starting'), false);
});
