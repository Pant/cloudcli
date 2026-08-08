import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionIdentity,
  isCommittedIdentityCurrent,
  resolveCommittedSessionIdentity,
  stabilizeSessionIdentity,
  shouldAdoptCanonicalSelection,
} from './sessionSelection';

test('rapid A to B to A resolves only the exact selected transcript', () => {
  const resolve = (id: string) => resolveCommittedSessionIdentity({ selectedSessionId: id, projectId: 'p', draft: null });
  assert.equal(resolve('a')?.key, 'selected:a:p');
  assert.equal(resolve('b')?.key, 'selected:b:p');
  assert.equal(resolve('a')?.key, 'selected:a:p');
});

test('unchanged primitive selection inputs retain the committed identity reference', () => {
  const initial = resolveCommittedSessionIdentity({ selectedSessionId: 'a', projectId: 'p', draft: null });
  const recalculated = resolveCommittedSessionIdentity({ selectedSessionId: 'a', projectId: 'p', draft: null });

  assert.equal(stabilizeSessionIdentity(initial, recalculated), initial);
});

test('a true selection change replaces the committed identity reference', () => {
  const a = resolveCommittedSessionIdentity({ selectedSessionId: 'a', projectId: 'p', draft: null });
  const b = resolveCommittedSessionIdentity({ selectedSessionId: 'b', projectId: 'p', draft: null });

  assert.equal(stabilizeSessionIdentity(a, b), b);
  assert.notEqual(stabilizeSessionIdentity(a, b), a);
});

test('a transient null selection exposes no previous selected transcript', () => {
  assert.equal(resolveCommittedSessionIdentity({ selectedSessionId: null, projectId: 'p', draft: null }), null);
});

test('a local draft survives null selection and is adopted by its canonical selection', () => {
  const draft = createSessionIdentity('draft', 'new', 'p');
  assert.equal(resolveCommittedSessionIdentity({ selectedSessionId: null, projectId: 'p', draft })?.key, draft.key);
  const selected = createSessionIdentity('selected', 'new', 'p');
  assert.equal(shouldAdoptCanonicalSelection(draft, selected), true);
});

test('stale callbacks and concurrent background sessions require exact identity', () => {
  const a = createSessionIdentity('selected', 'a', 'p');
  const b = createSessionIdentity('selected', 'b', 'p');
  assert.equal(isCommittedIdentityCurrent(a, b), false);
  assert.equal(isCommittedIdentityCurrent(b, b), true);
});
