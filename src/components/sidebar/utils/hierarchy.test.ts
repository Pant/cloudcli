import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectSession } from '../../../types/app';

import {
  annotateSessionForest,
  buildSessionForest,
  deriveRunningProjects,
  deriveRunningSessions,
  flattenExpandedBranches,
  getDefaultExpandedSessionIds,
  getSessionAncestorIds,
} from './hierarchy';

const session = (id: string, parentSessionId?: string | null, updatedAt = id, projectId?: string): ProjectSession => ({
  id,
  parentSessionId,
  updatedAt,
  __projectId: projectId,
  summary: id,
});

test('builds a deterministic deep forest and sorts siblings by subtree activity', () => {
  const forest = buildSessionForest([
    session('root', null, '2026-01-01T00:00:00Z'),
    session('old-child', 'root', '2026-01-02T00:00:00Z'),
    session('new-child', 'root', '2026-01-04T00:00:00Z'),
    session('grandchild', 'new-child', '2026-01-05T00:00:00Z'),
  ]);

  assert.deepEqual(forest.roots.map((node) => node.id), ['root']);
  assert.deepEqual(forest.roots[0]?.children.map((node) => node.id), ['new-child', 'old-child']);
  assert.equal(forest.nodes.get('grandchild')?.depth, 2);
  assert.deepEqual(getSessionAncestorIds(forest, 'grandchild'), ['new-child', 'root']);
});

test('makes orphans, self-links, cross-project parents, duplicate aliases, and cycles safe roots', () => {
  const forest = buildSessionForest([
    session('root', null, '2026-01-01T00:00:00Z', 'p'),
    session('orphan', 'missing', '2026-01-02T00:00:00Z', 'p'),
    session('self', 'self', '2026-01-03T00:00:00Z', 'p'),
    session('a', 'b', '2026-01-04T00:00:00Z', 'p'),
    session('b', 'a', '2026-01-05T00:00:00Z', 'p'),
    session('foreign-parent', null, '2026-01-06T00:00:00Z', 'other'),
    session('foreign-child', 'foreign-parent', '2026-01-07T00:00:00Z', 'p'),
    session('root', null, '2026-01-08T00:00:00Z', 'p'),
  ], 'p');

  assert.equal(forest.nodes.size, 6);
  assert.equal(forest.nodes.get('orphan')?.parentSessionId, null);
  assert.equal(forest.nodes.get('self')?.parentSessionId, null);
  assert.equal(forest.nodes.get('foreign-child')?.parentSessionId, null);
  assert.ok(forest.roots.some((node) => node.id === 'a' || node.id === 'b'));
  assert.doesNotThrow(() => flattenExpandedBranches(forest, getDefaultExpandedSessionIds(forest)));
});

test('annotates exact and descendant running/attention state and flattens only expanded branches', () => {
  const forest = buildSessionForest([
    session('root', null),
    session('child', 'root'),
    session('grandchild', 'child'),
  ]);
  annotateSessionForest(forest, new Set(['grandchild']), new Set(['child']));

  assert.equal(forest.nodes.get('grandchild')?.isRunning, true);
  assert.equal(forest.nodes.get('child')?.hasRunningDescendant, true);
  assert.equal(forest.nodes.get('root')?.hasRunningDescendant, true);
  assert.equal(forest.nodes.get('child')?.needsAttention, true);
  assert.deepEqual(flattenExpandedBranches(forest, new Set(['root'])).map((row) => row.id), ['root', 'child']);
});

test('folds newly discovered branches while preserving explicit expansion', () => {
  const forest = buildSessionForest([
    session('root', null),
    session('child', 'root'),
    session('grandchild', 'child'),
  ]);

  const defaultExpanded = getDefaultExpandedSessionIds(forest);
  assert.equal(defaultExpanded.size, 0);
  assert.deepEqual(flattenExpandedBranches(forest, defaultExpanded).map((row) => row.id), ['root']);
  assert.deepEqual(flattenExpandedBranches(forest, new Set(['root'])).map((row) => row.id), ['root', 'child']);
  assert.deepEqual(
    flattenExpandedBranches(forest, new Set(['root', 'child'])).map((row) => row.id),
    ['root', 'child', 'grandchild'],
  );
});

test('forced selected or running ancestor paths reveal folded branches', () => {
  const forest = annotateSessionForest(buildSessionForest([
    session('root', null),
    session('child', 'root'),
    session('grandchild', 'child'),
  ]), new Set(['grandchild']));
  const forcedPath = new Set(getSessionAncestorIds(forest, 'grandchild'));

  assert.deepEqual(
    flattenExpandedBranches(forest, getDefaultExpandedSessionIds(forest), forcedPath).map((row) => row.id),
    ['root', 'child', 'grandchild'],
  );
  assert.equal(forest.nodes.get('grandchild')?.isRunning, true);
});

test('keeps flat sessions visible and preserves explicit branch choices across merges', () => {
  const flatForest = buildSessionForest([
    session('first', null),
    session('second', null),
  ]);
  assert.deepEqual(
    flattenExpandedBranches(flatForest, getDefaultExpandedSessionIds(flatForest)).map((row) => row.id),
    ['first', 'second'],
  );

  const initiallyLoaded = buildSessionForest([
    session('root', null),
    session('child', 'root'),
  ]);
  const explicitExpansion = new Set(['root']);
  assert.deepEqual(flattenExpandedBranches(initiallyLoaded, explicitExpansion).map((row) => row.id), ['root', 'child']);

  const afterPageMerge = buildSessionForest([
    session('root', null),
    session('child', 'root'),
    session('grandchild', 'child'),
  ]);
  assert.deepEqual(flattenExpandedBranches(afterPageMerge, explicitExpansion).map((row) => row.id), ['root', 'child']);
});

test('running derivation includes active nodes once plus ancestors but counts exact active nodes', () => {
  const project = {
    projectId: 'p',
    displayName: 'Project',
    fullPath: '/project',
    sessions: [session('root', null), session('child', 'root'), session('grandchild', 'child')],
  };
  const active = new Set(['grandchild']);
  const derived = deriveRunningSessions(project, active);
  assert.deepEqual(derived.sessions.map((item) => item.id), ['root', 'child', 'grandchild']);
  assert.equal(derived.exactActiveCount, 1);
  assert.equal(deriveRunningProjects([project], active)[0]?.sessionMeta?.total, 1);
});

test('running grandchild context renders a complete unloaded path with exact active count', () => {
  const project = {
    projectId: 'p',
    displayName: 'Project',
    fullPath: '/project',
    sessions: [session('root', null), session('parent', 'root'), session('grandchild', 'parent')],
  };
  const derived = deriveRunningSessions(project, new Set(['grandchild']));
  assert.deepEqual(derived.sessions.map((item) => item.id), ['root', 'parent', 'grandchild']);
  assert.equal(derived.exactActiveCount, 1);
  assert.equal(derived.forest.nodes.get('root')?.isRunning, false);
  assert.equal(derived.forest.nodes.get('parent')?.isRunning, false);
  assert.equal(derived.forest.nodes.get('grandchild')?.isRunning, true);
  assert.equal(deriveRunningProjects([project], new Set(['grandchild']))[0]?.sessionMeta?.total, 1);
});
