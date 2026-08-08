import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project, ProjectSession } from '../types/app';

import { applyNewSessionIntent } from './useProjectsState';

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
  let url = '/session/existing-session';
  let mobileSidebarOpen = true;

  applyNewSessionIntent(clickedProject, {
    selectProject: (project) => { selectedProject = project; },
    clearSession: () => { selectedSession = null; },
    showChat: () => { activeTab = 'chat'; },
    triggerReset: () => { resetTrigger += 1; },
    navigateHome: () => { url = '/'; },
    closeSidebar: () => { mobileSidebarOpen = false; },
  });

  assert.equal(selectedProject, clickedProject);
  assert.equal(selectedSession, null);
  assert.equal(activeTab, 'chat');
  assert.equal(resetTrigger, 5);
  assert.equal(url, '/');
  assert.equal(mobileSidebarOpen, false);
});
