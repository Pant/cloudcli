import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';

import type { Project, ProjectSession, SessionLifecycleSnapshot  } from '../../../../types/app';
import { SessionStoreContext } from '../../../../stores/sessionStoreContext';

const { default: SidebarProjectSessions } = await import('./SidebarProjectSessions');

const translate = ((key: string, options?: { count?: number; defaultValue?: string }) => {
  if (options?.defaultValue) {
    return options.defaultValue;
  }
  return key;
}) as unknown as TFunction;

const session = (id: string, parentSessionId: string | null = null): ProjectSession => ({
  id,
  parentSessionId,
  summary: id,
  provider: 'opencode',
  __provider: 'opencode',
  lastActivity: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const project: Project = {
  projectId: 'project-1',
  displayName: 'Nested project',
  fullPath: '/tmp/nested-project',
  sessions: [session('root'), session('child', 'root'), session('grandchild', 'child')],
};

const renderSessions = (
  activeSessions = new Map<string, { startedAt: number; canInterrupt: boolean; statusText: string | null }>(),
  attentionSessionIds = new Set<string>(),
  currentTime = new Date('2026-01-01T01:00:00Z'),
  expandedSessionIds = new Set(['root', 'child']),
  forcedExpandedSessionIds = new Set<string>(),
  sessionLifecycle = new Map<string, SessionLifecycleSnapshot>(),
  isSessionSelectionMode = false,
  selectedSessionIds = new Set<string>(),
) => renderToStaticMarkup(
  React.createElement(SessionStoreContext.Provider, { value: { warmSession: async () => undefined } as never }, React.createElement(SidebarProjectSessions, {
    project,
    isExpanded: true,
    sessions: project.sessions as never,
    selectedSession: null,
    initialSessionsLoaded: true,
    hasMoreSessions: false,
    isLoadingMoreSessions: false,
    activeSessions,
    isSessionSelectionMode,
    selectedSessionIds,
    onToggleProjectSessionSelection: () => undefined,
    onRequestBulkSessionDelete: () => undefined,
    sessionLifecycle,
    onStartSession: async () => undefined,
     attentionSessionIds,
     expandedSessionIds,
     forcedExpandedSessionIds,
    onToggleSessionBranch: () => undefined,
     currentTime,
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
  })),
);

test('renders a flattened root/child/grandchild hierarchy with disclosure and depth styles', () => {
  const html = renderSessions();

  assert.match(html, /data-session-id="root" data-session-depth="0"/);
  assert.match(html, /data-session-id="child" data-session-depth="1"/);
  assert.match(html, /data-session-id="grandchild" data-session-depth="2"/);
  assert.match(html, /style="padding-left:48px"/);
  assert.match(html, /style="padding-left:64px"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Collapse children of root/);
  assert.match(html, /title="2 descendants">1 child/);
});

test('renders distinct lifecycle labels without counting terminal rows as processing', () => {
  const lifecycle = new Map<string, SessionLifecycleSnapshot>([
    ['root', { sessionId: 'root', provider: 'opencode', session: { id: 'root', provider: 'opencode' }, project: null, status: 'failed', lastActivityAt: 1, restartable: true, canInterrupt: false }],
    ['child', { sessionId: 'child', provider: 'opencode', parentSessionId: 'root', session: { id: 'child', provider: 'opencode' }, project: null, status: 'manually_stopped', lastActivityAt: 1, restartable: true, canInterrupt: false }],
    ['grandchild', { sessionId: 'grandchild', provider: 'opencode', parentSessionId: 'child', session: { id: 'grandchild', provider: 'opencode' }, project: null, status: 'recovering', lastActivityAt: 1, restartable: false, canInterrupt: true }],
  ]);
  const html = renderSessions(new Map([['grandchild', { startedAt: 1, canInterrupt: true, statusText: null }]]), new Set(), new Date('2026-01-01T01:00:00Z'), new Set(['root', 'child']), new Set(), lifecycle);
  assert.match(html, /aria-label="failed"/);
  assert.match(html, /aria-label="manually stopped"/);
  assert.match(html, /aria-label="recovering"/);
  assert.match(html, /aria-label="Restart session"|aria-label="Start session"/);
  assert.equal((html.match(/aria-label="Processing session"/g) ?? []).length, 2);
});

test('hides descendants for the collapsed default while keeping explicit expansion available', () => {
  const collapsedHtml = renderSessions(
    new Map(),
    new Set(),
    new Date('2026-01-01T01:00:00Z'),
    new Set(),
  );
  assert.match(collapsedHtml, /data-session-id="root" data-session-depth="0"/);
  assert.doesNotMatch(collapsedHtml, /data-session-id="child"/);
  assert.doesNotMatch(collapsedHtml, /data-session-id="grandchild"/);
  assert.match(collapsedHtml, /aria-expanded="false"/);
  assert.match(collapsedHtml, /Expand children of root/);

  const expandedHtml = renderSessions();
  assert.match(expandedHtml, /data-session-id="grandchild" data-session-depth="2"/);
});

test('forced selected or running paths reveal ancestors despite the folded default', () => {
  const html = renderSessions(
    new Map([
      ['grandchild', { startedAt: 1, canInterrupt: false, statusText: null }],
    ]),
    new Set(),
    new Date('2026-01-01T01:00:00Z'),
    new Set(),
    new Set(['root', 'child']),
  );

  assert.match(html, /data-session-id="root" data-session-depth="0"/);
  assert.match(html, /data-session-id="child" data-session-depth="1"/);
  assert.match(html, /data-session-id="grandchild" data-session-depth="2"/);
});

test('marks only the exact running row as processing and ancestors as descendant context', () => {
  const html = renderSessions(new Map([
    ['grandchild', { startedAt: 1, canInterrupt: false, statusText: null }],
  ]));

  const rowMarkup = (id: string) => {
    const start = html.indexOf(`data-session-id="${id}"`);
    const end = html.indexOf('data-session-id="', start + 1);
    return html.slice(start, end === -1 ? undefined : end);
  };

  assert.match(rowMarkup('grandchild'), /aria-label="Processing session"/);
  assert.equal((rowMarkup('grandchild').match(/aria-label="Processing session"/g) ?? []).length, 2);
  assert.match(rowMarkup('grandchild'), /bg-blue-500 ring-2 ring-blue-500\/20/);
  assert.doesNotMatch(rowMarkup('grandchild'), /animate-(?:spin|pulse)/);
  assert.match(rowMarkup('root'), /1 descendant processing/);
  assert.match(rowMarkup('child'), /1 descendant processing/);
  assert.doesNotMatch(rowMarkup('root'), /animate-(?:spin|pulse)/);
  assert.doesNotMatch(rowMarkup('child'), /animate-(?:spin|pulse)/);
});

test('keeps attention and recently active session markers static and distinguishable', () => {
  const attentionHtml = renderSessions(new Map(), new Set(['root']));
  const attentionStart = attentionHtml.indexOf('data-session-id="root"');
  const attentionEnd = attentionHtml.indexOf('data-session-id="', attentionStart + 1);
  const attentionRow = attentionHtml.slice(attentionStart, attentionEnd === -1 ? undefined : attentionEnd);

  assert.match(attentionRow, /bg-amber-500/);
  assert.match(attentionRow, /Session needs attention/);
  assert.doesNotMatch(attentionRow, /animate-(?:spin|pulse)/);

  const recentHtml = renderSessions(
    new Map(),
    new Set(),
    new Date('2026-01-01T00:05:00Z'),
  );
  const recentStart = recentHtml.indexOf('data-session-id="root"');
  const recentEnd = recentHtml.indexOf('data-session-id="', recentStart + 1);
  const recentRow = recentHtml.slice(recentStart, recentEnd === -1 ? undefined : recentEnd);

  assert.match(recentRow, /bg-green-500/);
  assert.match(recentRow, /Recently active session \(last 10 minutes\)/);
  assert.doesNotMatch(recentRow, /animate-(?:spin|pulse)/);
});

test('sidebar controls emit only atomic New Session and session-selection intents', async () => {
  const [projectSessionsSource, sessionItemSource] = await Promise.all([
    readFile(new URL('./SidebarProjectSessions.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./SidebarSessionItem.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(projectSessionsSource, /onClick=\{\(\) => onNewSession\(project\)\}/);
  assert.equal((projectSessionsSource.match(/onClick=\{\(\) => onNewSession\(project\)\}/g) ?? []).length, 2);
  assert.doesNotMatch(projectSessionsSource, /onProjectSelect\(project\);\s*onNewSession/);
  assert.match(sessionItemSource, /onSessionSelect\(session, project\);/);
  assert.doesNotMatch(sessionItemSource, /onProjectSelect\(project\);\s*onSessionSelect/);
  assert.match(sessionItemSource, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
  assert.match(sessionItemSource, /onPointerEnter=\{warmSessionOnIntent\}/);
  assert.match(sessionItemSource, /onFocus=\{warmSessionOnIntent\}/);
  assert.match(sessionItemSource, /if \(!isSelectionMode\) void sessionStore\.warmSession\(session\.id\)/);
});

test('renders project selection controls and accessible selected row markup', () => {
  const html = renderSessions(new Map(), new Set(), new Date('2026-01-01T01:00:00Z'), new Set(['root', 'child']), new Set(), new Map(), true, new Set(['root']));
  assert.match(html, /data-selection-controls/);
  assert.match(html, /selection\.selectAll/);
  assert.match(html, /data-session-id="root"[^>]*data-selection-selected="true"/);
  assert.match(html, /role="checkbox" aria-checked="true"/);
});

test('selection-mode click contract prevents navigation and branch toggling', async () => {
  const source = await readFile(new URL('./SidebarSessionItem.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(isSelectionMode\) \{\s*event\.preventDefault\(\);\s*selectAndToggleSession\(\);\s*return;/);
  assert.match(source, /if \(!isSelectionMode && rowInteractionPolicy\.togglesOnRowClick\)/);
});
