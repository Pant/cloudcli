import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project, ProjectSession, RunningSessionSnapshot } from '../types/app';

import {
  mergeExpandedSessionPages,
  mergeProjectSessionPage,
  mergeRunningSessionSnapshot,
  mergeRunningSnapshotsIntoProjects,
  sessionHistoryRevision,
  shouldSignalExternalHistoryRefresh,
  upsertSessionIntoProject,
} from './projectStateUtils';

const project = (sessions: ProjectSession[], meta: Project['sessionMeta'] = {}): Project => ({
  projectId: 'p',
  displayName: 'Project',
  fullPath: '/project',
  sessions,
  sessionMeta: meta,
});

const item = (id: string, parentSessionId?: string | null): ProjectSession => ({
  id,
  parentSessionId,
  summary: id,
  updatedAt: '2026-01-01T00:00:00Z',
});

test('selected-session history refreshes once per inactive canonical revision', () => {
  assert.equal(sessionHistoryRevision({ id: 's', lastActivity: 'rev-2', updated_at: 'rev-1' }), 'rev-2');
  assert.equal(shouldSignalExternalHistoryRefresh({
    viewedSessionId: 's', eventSessionId: 's', active: false,
    currentRevision: 'rev-1', incomingRevision: 'rev-2', lastSignaledRevision: null,
  }), true);
  assert.equal(shouldSignalExternalHistoryRefresh({
    viewedSessionId: 's', eventSessionId: 's', active: false,
    currentRevision: 'rev-1', incomingRevision: 'rev-2', lastSignaledRevision: 'rev-2',
  }), false);
  assert.equal(shouldSignalExternalHistoryRefresh({
    viewedSessionId: 's', eventSessionId: 's', active: true,
    currentRevision: 'rev-1', incomingRevision: 'rev-2', lastSignaledRevision: null,
  }), false);
});

test('page merging deduplicates aliases and preserves authoritative root offsets', () => {
  const existing = project([item('root'), item('child', 'root')], {
    total: 2,
    rootTotal: 4,
    rootOffset: 0,
    nextOffset: 4,
    hasMore: true,
  });
  const page = { sessions: [item('child', 'root'), item('grandchild', 'child')], sessionMeta: {
    total: 3,
    rootTotal: 4,
    rootOffset: 4,
    nextOffset: 8,
    hasMore: false,
  } };
  const merged = mergeProjectSessionPage(existing, page);
  assert.deepEqual(merged.sessions?.map((session) => session.id), ['root', 'child', 'grandchild']);
  assert.equal(merged.sessionMeta?.nextOffset, 8);
  assert.equal(merged.sessionMeta?.rootOffset, 4);
});

test('expanded full refresh retains loaded descendants without corrupting page metadata', () => {
  const previous = [project([item('root'), item('child', 'root')], { total: 3, nextOffset: 4, hasMore: true })];
  const incoming = [project([item('root')], { total: 3, nextOffset: 4, hasMore: true })];
  const merged = mergeExpandedSessionPages(previous, incoming);
  assert.deepEqual(merged[0]?.sessions?.map((session) => session.id), ['root', 'child']);
  assert.equal(merged[0]?.sessionMeta?.nextOffset, 4);
});

test('upserts accept later reparenting without creating duplicate canonical rows', () => {
  const initial = project([item('child', null)], { total: 1, hasMore: false });
  const withParent = upsertSessionIntoProject(initial, {
    sessionId: 'child',
    session: item('child', 'parent'),
  });
  const final = upsertSessionIntoProject(withParent, {
    sessionId: 'parent',
    session: item('parent', null),
  });
  assert.equal(final.sessions?.length, 2);
  assert.equal(final.sessions?.find((session) => session.id === 'child')?.parentSessionId, 'parent');
});

test('upserts preserve omitted parents, while null and canonical strings remain authoritative', () => {
  const initial = project([item('root', null), item('child', 'root')], {
    total: 2,
    rootTotal: 1,
    rootOffset: 3,
    nextOffset: 5,
    hasMore: true,
  });

  const unresolved = upsertSessionIntoProject(initial, {
    sessionId: 'child',
    session: { id: 'provider-child', summary: 'partial update' },
  });
  assert.equal(unresolved.sessions?.find((session) => session.id === 'child')?.parentSessionId, 'root');
  assert.equal(unresolved.sessionMeta?.rootTotal, 1);
  assert.equal(unresolved.sessionMeta?.rootOffset, 3);
  assert.equal(unresolved.sessionMeta?.nextOffset, 5);

  const explicitRoot = upsertSessionIntoProject(unresolved, {
    sessionId: 'child',
    session: { id: 'provider-child', parentSessionId: null, summary: 'detached' },
  });
  assert.equal(explicitRoot.sessions?.find((session) => session.id === 'child')?.parentSessionId, null);
  assert.equal(explicitRoot.sessionMeta?.rootTotal, 2);

  const reparented = upsertSessionIntoProject(explicitRoot, {
    sessionId: 'child',
    session: { id: 'provider-child', parentSessionId: 'root', summary: 'reattached' },
  });
  assert.equal(reparented.sessions?.find((session) => session.id === 'child')?.parentSessionId, 'root');
  assert.equal(reparented.sessionMeta?.rootTotal, 1);
  assert.equal(reparented.sessions?.filter((session) => session.id === 'child').length, 1);
});

test('unresolved inserted rows do not become roots until an explicit root event arrives', () => {
  const initial = project([], {
    total: 0,
    rootTotal: 0,
    rootOffset: 7,
    nextOffset: 7,
    hasMore: false,
  });

  const unresolved = upsertSessionIntoProject(initial, {
    sessionId: 'child',
    session: { id: 'native-child', summary: 'waiting for mapping' },
  });
  assert.equal(unresolved.sessions?.[0]?.id, 'child');
  assert.equal(unresolved.sessions?.[0]?.parentSessionId, undefined);
  assert.equal(unresolved.sessionMeta?.rootTotal, 0);
  assert.equal(unresolved.sessionMeta?.rootOffset, 7);
  assert.equal(unresolved.sessionMeta?.nextOffset, 7);

  const resolved = upsertSessionIntoProject(unresolved, {
    sessionId: 'child',
    session: { id: 'native-child', parentSessionId: 'parent', summary: 'mapped' },
  });
  assert.equal(resolved.sessions?.[0]?.parentSessionId, 'parent');
  assert.equal(resolved.sessionMeta?.rootTotal, 0);

  const root = upsertSessionIntoProject(resolved, {
    sessionId: 'child',
    session: { id: 'native-child', parentSessionId: null, summary: 'confirmed root' },
  });
  assert.equal(root.sessions?.[0]?.parentSessionId, null);
  assert.equal(root.sessionMeta?.rootTotal, 1);
});

test('page merges preserve relationships from loaded rows when incoming parent is omitted', () => {
  const existing = project([item('root', null), item('child', 'root')], {
    total: 2,
    rootTotal: 1,
    rootOffset: 4,
    nextOffset: 6,
    hasMore: false,
  });
  const merged = mergeProjectSessionPage(existing, {
    sessions: [{ id: 'child', summary: 'page refresh without relationship' }],
    sessionMeta: { total: 2, rootTotal: 1, rootOffset: 4, nextOffset: 6, hasMore: false },
  });

  assert.equal(merged.sessions?.find((session) => session.id === 'child')?.parentSessionId, 'root');
  assert.equal(merged.sessionMeta?.rootTotal, 1);
  assert.equal(merged.sessionMeta?.rootOffset, 4);
  assert.equal(merged.sessionMeta?.nextOffset, 6);
});

test('running snapshots hydrate off-page children and ancestors without moving root pagination', () => {
  const initial = project([item('root')], { total: 3, rootTotal: 1, rootOffset: 0, nextOffset: 1, hasMore: false });
  const snapshot: RunningSessionSnapshot = {
    sessionId: 'child',
    provider: 'opencode',
    parentSessionId: 'root',
    project: { projectId: 'p', path: '/project', fullPath: '/project', displayName: 'Project' },
    session: { id: 'child', provider: 'opencode', summary: 'Child', lastActivity: '2026-01-02T00:00:00Z' },
  };
  const merged = mergeRunningSessionSnapshot([initial], snapshot)[0];
  assert.deepEqual(merged?.sessions?.map((session) => session.id), ['child', 'root']);
  assert.equal(merged?.sessions?.find((session) => session.id === 'child')?.parentSessionId, 'root');
  assert.equal(merged?.sessionMeta?.nextOffset, 1);
  assert.equal(merged?.sessionMeta?.total, 3);
});

test('running snapshot project changes rehome a canonical session exactly once', () => {
  const first = project([item('child')], { total: 1 });
  const second: Project = { ...project([], { total: 0 }), projectId: 'q', displayName: 'Q' };
  const snapshot: RunningSessionSnapshot = {
    sessionId: 'child',
    provider: 'opencode',
    project: { projectId: 'q', path: '/q', fullPath: '/q', displayName: 'Q' },
    session: { id: 'child', provider: 'opencode', summary: 'Child' },
  };
  const merged = mergeRunningSnapshotsIntoProjects([first, second], new Map([[snapshot.sessionId, snapshot]]));
  assert.equal(merged[0]?.sessions?.length, 0);
  assert.deepEqual(merged[1]?.sessions?.map((session) => session.id), ['child']);
});

test('running grandchild snapshot hydrates unloaded root and intermediate context without counting it', () => {
  const initial = project([], { total: 3, rootTotal: 1, rootOffset: 0, nextOffset: 1, hasMore: false });
  const snapshot: RunningSessionSnapshot = {
    sessionId: 'grandchild',
    provider: 'opencode',
    parentSessionId: 'parent',
    project: { projectId: 'p', path: '/project', fullPath: '/project', displayName: 'Project' },
    session: { id: 'grandchild', provider: 'opencode', summary: 'Grandchild' },
    ancestors: [
      {
        sessionId: 'parent',
        provider: 'opencode',
        parentSessionId: 'root',
        project: { projectId: 'p', path: '/project', fullPath: '/project', displayName: 'Project' },
        session: { id: 'parent', provider: 'opencode', summary: 'Parent' },
      },
      {
        sessionId: 'root',
        provider: 'opencode',
        parentSessionId: null,
        project: { projectId: 'p', path: '/project', fullPath: '/project', displayName: 'Project' },
        session: { id: 'root', provider: 'opencode', summary: 'Root' },
      },
    ],
  };

  const merged = mergeRunningSessionSnapshot([initial], snapshot)[0];
  assert.deepEqual(merged?.sessions?.map((session) => session.id), ['grandchild', 'parent', 'root']);
  assert.equal(merged?.sessions?.find((session) => session.id === 'parent')?.parentSessionId, 'root');
  assert.equal(merged?.sessions?.find((session) => session.id === 'root')?.parentSessionId, null);
  assert.equal(merged?.sessionMeta?.total, 3);
  assert.equal(merged?.sessionMeta?.rootTotal, 1);
  assert.equal(merged?.sessionMeta?.nextOffset, 1);
});

test('shared running ancestors are deduplicated while exact activity remains separate', () => {
  const initial = project([], { total: 4, rootTotal: 1, rootOffset: 0, nextOffset: 1, hasMore: false });
  const makeSnapshot = (sessionId: string): RunningSessionSnapshot => ({
    sessionId,
    provider: 'opencode',
    parentSessionId: 'parent',
    project: { projectId: 'p', path: '/project', fullPath: '/project', displayName: 'Project' },
    session: { id: sessionId, provider: 'opencode', summary: sessionId },
    ancestors: [
      {
        sessionId: 'parent',
        provider: 'opencode',
        parentSessionId: 'root',
        project: { projectId: 'p', path: '/project', fullPath: '/project', displayName: 'Project' },
        session: { id: 'parent', provider: 'opencode', summary: 'Parent' },
      },
      {
        sessionId: 'root',
        provider: 'opencode',
        parentSessionId: null,
        project: { projectId: 'p', path: '/project', fullPath: '/project', displayName: 'Project' },
        session: { id: 'root', provider: 'opencode', summary: 'Root' },
      },
    ],
  });

  const first = makeSnapshot('grandchild-a');
  const second = makeSnapshot('grandchild-b');
  const merged = mergeRunningSnapshotsIntoProjects(
    [initial],
    new Map([[first.sessionId, first], [second.sessionId, second]]),
  )[0];
  assert.deepEqual(merged?.sessions?.map((session) => session.id), [
    'grandchild-b',
    'grandchild-a',
    'parent',
    'root',
  ]);
  assert.equal(new Set(merged?.sessions?.map((session) => session.id)).size, 4);
  assert.equal(merged?.sessionMeta?.total, 4);
  assert.equal(merged?.sessionMeta?.nextOffset, 1);
});
