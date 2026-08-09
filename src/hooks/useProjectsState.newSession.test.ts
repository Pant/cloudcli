import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project, ProjectSession } from '../types/app';

import { applyNewSessionIntent, applySessionSelectionIntent, getProjectDraftUrl, resolveProjectRoute } from './useProjectsState';

test('one New Session callback clears an existing session and opens a clean draft for the clicked project', () => {
  const clickedProject = {
    projectId: 'project-2',
    displayName: 'Clicked project',
    fullPath: '/tmp/clicked-project',
    sessions: [],
  } satisfies Project;
  let selectedProject: Project | null = {
    projectId: 'project-1',
    displayName: 'Previous project',
    fullPath: '/tmp/previous-project',
    sessions: [],
  };
  let selectedSession: ProjectSession | null = { id: 'existing-session', summary: 'Existing transcript' };
  let activeTab = 'files';
  let resetTrigger = 4;
  const navigations: string[] = [];
  let mobileSidebarOpen = true;

  applyNewSessionIntent(clickedProject, {
    selectProject: (project) => { selectedProject = project; },
    clearSession: () => { selectedSession = null; },
    showChat: () => { activeTab = 'chat'; },
    triggerReset: () => { resetTrigger += 1; },
    navigateToDraft: (project) => { navigations.push(getProjectDraftUrl(project.projectId)); },
    closeSidebar: () => { mobileSidebarOpen = false; },
  });

  assert.equal(selectedProject, clickedProject);
  assert.equal(selectedSession, null);
  assert.equal(activeTab, 'chat');
  assert.equal(resetTrigger, 5);
  assert.deepEqual(navigations, ['/project/project-2/new']);
  assert.equal(mobileSidebarOpen, false);
});

test('New Session encodes the clicked canonical project id in exactly one navigation', () => {
  const clickedProject = {
    projectId: 'project/with spaces',
    displayName: 'Encoded project',
    fullPath: '/tmp/encoded-project',
    sessions: [],
  } satisfies Project;
  const navigations: string[] = [];

  applyNewSessionIntent(clickedProject, {
    selectProject: () => undefined,
    clearSession: () => undefined,
    showChat: () => undefined,
    triggerReset: () => undefined,
    navigateToDraft: (project) => navigations.push(getProjectDraftUrl(project.projectId)),
  });

  assert.deepEqual(navigations, ['/project/project%2Fwith%20spaces/new']);
});

test('project draft route resolves authoritatively after delayed availability and rejects stale selection', () => {
  const staleProject = { projectId: 'stale', displayName: 'Stale', fullPath: '/tmp/stale', sessions: [] } satisfies Project;
  const routeProject = { projectId: 'route-project', displayName: 'Route', fullPath: '/tmp/route', sessions: [] } satisfies Project;

  assert.equal(resolveProjectRoute('route-project', []), null);
  assert.equal(resolveProjectRoute('unknown', [staleProject]), null);
  assert.equal(resolveProjectRoute('route-project', [staleProject, routeProject]), routeProject);
});

test('one session selection atomically establishes its project and session before one target navigation', () => {
  const project = { projectId: 'project-2', displayName: 'Project 2', fullPath: '/tmp/project-2', sessions: [] } satisfies Project;
  const session = { id: 'session-2', summary: 'Session 2' } satisfies ProjectSession;
  const transitions: string[] = [];

  applySessionSelectionIntent(project, session, {
    clearAttention: (id) => transitions.push(`attention:${id}`),
    selectProject: (selected) => transitions.push(`project:${selected.projectId}`),
    selectSession: (selected) => transitions.push(`session:${selected.id}`),
    showChat: () => transitions.push('tab:chat'),
    navigateToSession: (id) => transitions.push(`navigate:/session/${id}`),
    closeSidebar: () => transitions.push('sidebar:closed'),
  });

  assert.deepEqual(transitions, [
    'attention:session-2',
    'project:project-2',
    'session:session-2',
    'tab:chat',
    'navigate:/session/session-2',
    'sidebar:closed',
  ]);
  assert.equal(transitions.filter((transition) => transition.startsWith('navigate:')).length, 1);
});
