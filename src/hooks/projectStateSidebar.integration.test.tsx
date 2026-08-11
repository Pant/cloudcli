import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';

import type { Project, ProjectSession } from '../types/app';
import SidebarProjectSessions from '../components/sidebar/view/subcomponents/SidebarProjectSessions';
import type { SessionWithProvider } from '../components/sidebar/types/types';
import { buildSessionForest, getNewSessionEdgeAncestorIds } from '../components/sidebar/utils/hierarchy';
import { SessionStoreContext } from '../stores/sessionStoreContext';

import { upsertSessionIntoProject, type SessionUpsert } from './projectStateUtils';

const translate = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as unknown as TFunction;

const project: Project = {
  projectId: 'project-1',
  displayName: 'Nested project',
  fullPath: '/tmp/nested-project',
  sessions: [],
  sessionMeta: {
    total: 0,
    rootTotal: 0,
    rootOffset: 0,
    nextOffset: 0,
    hasMore: false,
  },
};

const event = (
  sessionId: string,
  session: Omit<ProjectSession, 'id'>,
): SessionUpsert => ({
  sessionId,
  provider: 'opencode',
  session: {
    ...session,
    // The provider-native id intentionally differs from the canonical event id.
    id: `opencode-${sessionId}`,
    provider: 'opencode',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  project: {
    projectId: 'project-1',
    path: '/tmp/nested-project',
    fullPath: '/tmp/nested-project',
    displayName: 'Nested project',
    isStarred: false,
  },
});

const renderSidebar = (state: Project, expandedSessionIds = new Set(['root', 'child'])) => renderToStaticMarkup(
  React.createElement(
    SessionStoreContext.Provider,
    { value: { warmSession: async () => undefined } as never },
    React.createElement(SidebarProjectSessions, {
      project: state,
      isExpanded: true,
      sessions: (state.sessions ?? []) as SessionWithProvider[],
      selectedSession: null,
      initialSessionsLoaded: true,
      hasMoreSessions: state.sessionMeta?.hasMore ?? false,
      isLoadingMoreSessions: false,
      activeSessions: new Map(),
      attentionSessionIds: new Set<string>(),
      expandedSessionIds,
      forcedExpandedSessionIds: new Set<string>(),
      onToggleSessionBranch: () => undefined,
      currentTime: new Date('2026-01-01T01:00:00Z'),
      editingSession: null,
      editingSessionName: '',
      onEditingSessionNameChange: () => undefined,
      onStartEditingSession: () => undefined,
      onCancelEditingSession: () => undefined,
      onSaveEditingSession: () => undefined,
      onProjectSelect: () => undefined,
      onSessionSelect: () => undefined,
      onDeleteSession: () => undefined,
      onLoadMoreSessions: () => undefined,
      onNewSession: () => undefined,
      t: translate,
    }),
  ),
);

test('live state helpers feed ordered production-shaped events into nested sidebar markup', () => {
  let state = project;
  const orderedEvents = [
    event('root', { parentSessionId: null, summary: 'Root session' }),
    event('child', { parentSessionId: 'root', summary: 'Child session' }),
    event('grandchild', { parentSessionId: 'child', summary: 'Grandchild session' }),
  ];

  for (const upsert of orderedEvents) {
    state = upsertSessionIntoProject(state, upsert);
  }

  assert.equal(state.sessionMeta?.rootTotal, 1);
  assert.equal(state.sessionMeta?.rootOffset, 0);
  assert.equal(state.sessionMeta?.nextOffset, 0);
  assert.deepEqual(
    state.sessions?.map((session) => [session.id, session.parentSessionId]),
    [['grandchild', 'child'], ['child', 'root'], ['root', null]],
  );

  const html = renderSidebar(state);
  assert.match(html, /data-session-id="root" data-session-depth="0"/);
  assert.match(html, /data-session-id="child" data-session-depth="1"/);
  assert.match(html, /data-session-id="grandchild" data-session-depth="2"/);
  assert.match(html, /style="padding-left:48px"/);
  assert.match(html, /style="padding-left:64px"/);
  assert.doesNotMatch(html, /opencode-(?:root|child|grandchild)/);
});

test('realtime canonical child edges reveal nested rows after the initial folded snapshot', () => {
  let state = upsertSessionIntoProject(project, event('root', { parentSessionId: null, summary: 'Root session' }));
  let previousForest = buildSessionForest(state.sessions ?? [], state.projectId);
  let expanded = new Set<string>();
  assert.doesNotMatch(renderSidebar(state, expanded), /data-session-id="child"/);

  state = upsertSessionIntoProject(state, event('child', { parentSessionId: 'root', summary: 'Child session' }));
  let currentForest = buildSessionForest(state.sessions ?? [], state.projectId);
  expanded = new Set([...expanded, ...getNewSessionEdgeAncestorIds(previousForest, currentForest)]);
  assert.match(renderSidebar(state, expanded), /data-session-id="child" data-session-depth="1"/);

  previousForest = currentForest;
  state = upsertSessionIntoProject(state, event('grandchild', { parentSessionId: 'child', summary: 'Grandchild session' }));
  currentForest = buildSessionForest(state.sessions ?? [], state.projectId);
  expanded = new Set([...expanded, ...getNewSessionEdgeAncestorIds(previousForest, currentForest)]);
  assert.match(renderSidebar(state, expanded), /data-session-id="grandchild" data-session-depth="2"/);
});
