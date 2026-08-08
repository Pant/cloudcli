import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionMessageLoadingOwner } from './sessionMessageLoading';

test('New Session invalidates an in-flight session message load', () => {
  const owner = createSessionMessageLoadingOwner();
  const oldSessionLoad = owner.begin();

  owner.invalidate();

  assert.equal(owner.isCurrent(oldSessionLoad), false);
});

test('a stale completion cannot clear a later session load', () => {
  const owner = createSessionMessageLoadingOwner();
  const oldSessionLoad = owner.begin();
  owner.invalidate();
  const laterSessionLoad = owner.begin();

  assert.equal(owner.isCurrent(oldSessionLoad), false);
  assert.equal(owner.isCurrent(laterSessionLoad), true);
});
