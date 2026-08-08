import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canInitializeRepository,
  repositoryCacheKey,
  repositoryDiscoveryMessage,
  repositoryLabel,
  selectDiscoveredRepository,
  shouldLoadRepositoryStatus,
  workspaceFilePath,
} from './repositoryUtils';

test('selects a retained repository, then root, then first nested repository', () => {
  assert.equal(selectDiscoveredRepository(['.', 'apps/api'], 'apps/api'), 'apps/api');
  assert.equal(selectDiscoveredRepository(['apps/api', '.'], 'missing'), '.');
  assert.equal(selectDiscoveredRepository(['apps/api'], null), 'apps/api');
  assert.equal(selectDiscoveredRepository([], null), null);
});

test('translates repository-relative paths only for nested repositories', () => {
  assert.equal(workspaceFilePath('.', 'src/a.ts'), 'src/a.ts');
  assert.equal(workspaceFilePath('apps/api', 'src/a.ts'), 'apps/api/src/a.ts');
});

test('creates repository-specific cache keys', () => {
  assert.notEqual(repositoryCacheKey('/workspace', '.'), repositoryCacheKey('/workspace', 'apps/api'));
});

test('gates status loading on successful repository discovery', () => {
  assert.equal(shouldLoadRepositoryStatus('pending', null, []), false);
  assert.equal(shouldLoadRepositoryStatus('error', null, []), false);
  assert.equal(shouldLoadRepositoryStatus('success', 'cloudcli-src', ['cloudcli-src']), true);
  assert.equal(shouldLoadRepositoryStatus('success', null, []), true);
});

test('offers initialization only for a confirmed empty non-git workspace', () => {
  assert.equal(canInitializeRepository('pending', [], true), false);
  assert.equal(canInitializeRepository('error', [], true), false);
  assert.equal(canInitializeRepository('success', ['cloudcli-src'], true), false);
  assert.equal(canInitializeRepository('success', [], false), false);
  assert.equal(canInitializeRepository('success', [], true), true);
});

test('formats concise repository labels', () => {
  assert.equal(repositoryLabel('.'), 'Project root');
  assert.equal(repositoryLabel('cloudcli-src'), 'cloudcli-src');
});

test('describes every repository discovery state', () => {
  assert.equal(repositoryDiscoveryMessage('pending', 0), 'Discovering repositories…');
  assert.equal(repositoryDiscoveryMessage('error', 0), 'Repository discovery failed');
  assert.equal(repositoryDiscoveryMessage('success', 0), 'No repositories discovered');
  assert.equal(repositoryDiscoveryMessage('success', 1), '1 repository discovered');
  assert.equal(repositoryDiscoveryMessage('success', 2), '2 repositories discovered');
});
