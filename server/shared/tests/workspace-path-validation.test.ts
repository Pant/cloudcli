import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { validateWorkspacePath, WORKSPACES_ROOT } from '@/shared/utils.js';

test('accepts canonical /tmp and existing or nonexistent descendants', async (t) => {
  if (process.platform === 'win32') return;

  const fixture = await mkdtemp('/tmp/cloudcli-workspace-validation-');
  t.after(async () => rm(fixture, { recursive: true, force: true }));
  const existing = path.join(fixture, 'existing');
  await mkdir(existing);

  for (const candidate of ['/tmp', existing, path.join(fixture, 'missing', 'nested', 'workspace')]) {
    const result = await validateWorkspacePath(candidate);
    assert.equal(result.valid, true, `${candidate}: ${result.error}`);
  }
});

test('rejects non-temporary paths outside WORKSPACES_ROOT and forbidden roots', async () => {
  if (process.platform === 'win32') return;

  const outsideRoot = WORKSPACES_ROOT === '/mnt' ? '/srv/cloudcli-workspace' : '/mnt/cloudcli-workspace';
  assert.equal((await validateWorkspacePath(outsideRoot)).valid, false);

  for (const candidate of ['/', '/etc', '/etc/cloudcli', '/var', '/var/log', '/usr/local']) {
    assert.equal((await validateWorkspacePath(candidate)).valid, false, candidate);
  }
});

test('rejects existing and prospective paths whose canonical /tmp parent escapes through a symlink', async (t) => {
  if (process.platform === 'win32') return;

  const fixture = await mkdtemp('/tmp/cloudcli-workspace-symlink-');
  const outside = await mkdtemp('/var/tmp/cloudcli-workspace-outside-');
  t.after(async () => {
    await rm(fixture, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const escape = path.join(fixture, 'escape');
  await symlink(outside, escape, 'dir');

  assert.equal((await validateWorkspacePath(escape)).valid, false);
  assert.equal((await validateWorkspacePath(path.join(escape, 'missing', 'workspace'))).valid, false);
});
