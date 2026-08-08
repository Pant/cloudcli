import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionMessageLoadingOwner } from './sessionMessageLoading';

test('New Session invalidates an in-flight session message load', () => {
  const owner = createSessionMessageLoadingOwner();
  const oldSessionLoad = owner.begin('selected:a:p');

  owner.invalidate();

  assert.equal(owner.isCurrent(oldSessionLoad, 'selected:a:p'), false);
});

test('a stale completion cannot clear a later session load', () => {
  const owner = createSessionMessageLoadingOwner();
  const oldSessionLoad = owner.begin('selected:a:p');
  owner.invalidate();
  const laterSessionLoad = owner.begin('selected:b:p');

  assert.equal(owner.isCurrent(oldSessionLoad, 'selected:a:p'), false);
  assert.equal(owner.isCurrent(laterSessionLoad, 'selected:b:p'), true);
  assert.equal(owner.isCurrent(laterSessionLoad, 'selected:a:p'), false);
});

test('starting B directly transfers ownership away from an in-flight A load', () => {
  const owner = createSessionMessageLoadingOwner();
  const a = owner.begin('selected:a:p');
  const b = owner.begin('selected:b:p');

  assert.equal(owner.isCurrent(a, 'selected:a:p'), false);
  assert.equal(owner.isCurrent(b, 'selected:b:p'), true);
});
