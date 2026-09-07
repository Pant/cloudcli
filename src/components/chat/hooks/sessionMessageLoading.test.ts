import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExternalSessionRefreshOwner,
  createSessionMessageLoadingOwner,
  shouldBlockSessionMessageDisplay,
} from './sessionMessageLoading';

test('warmed and cache-hydrated rows do not block while canonical validation continues', () => {
  assert.equal(shouldBlockSessionMessageDisplay({ hasDisplayableMessages: true, isCanonicalLoading: true }), false);
});

test('an empty session blocks only while its canonical history is loading', () => {
  assert.equal(shouldBlockSessionMessageDisplay({ hasDisplayableMessages: false, isCanonicalLoading: true }), true);
  assert.equal(shouldBlockSessionMessageDisplay({ hasDisplayableMessages: false, isCanonicalLoading: false }), false);
});

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

test('one external revision refreshes once across repeated renders and later revisions still refresh', () => {
  const owner = createExternalSessionRefreshOwner();
  owner.select('selected:a:p', 0);

  assert.equal(owner.consume('selected:a:p', 1, false), true);
  assert.equal(owner.consume('selected:a:p', 1, false), false);
  assert.equal(owner.consume('selected:a:p', 1, false), false);
  assert.equal(owner.consume('selected:a:p', 2, false), true);
});

test('external revisions are consumed while streaming and fenced across selection changes', () => {
  const owner = createExternalSessionRefreshOwner();
  owner.select('selected:a:p', 0);

  assert.equal(owner.consume('selected:a:p', 1, true), false);
  assert.equal(owner.consume('selected:a:p', 1, false), false);

  owner.select('selected:b:p', 1);
  assert.equal(owner.consume('selected:b:p', 1, false), false);
  assert.equal(owner.consume('selected:a:p', 2, false), false);
  assert.equal(owner.consume('selected:b:p', 2, false), true);
});
