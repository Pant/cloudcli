import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';

import { GitRepositoryService } from '@/modules/git/git-repository.service.js';

const execFileAsync = promisify(execFile);
const fixtureRoot = path.resolve('.test-output/git-repository-fixtures');
const runCommand = async (command: string, args: string[], options?: { cwd?: string }) => {
  const result = await execFileAsync(command, args, { ...options, encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr };
};

async function withWorkspace(run: (workspacePath: string) => Promise<void>): Promise<void> {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const workspacePath = await fs.mkdtemp(path.join(fixtureRoot, 'git-repositories-'));
  try { await run(workspacePath); } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function initRepository(repositoryPath: string): Promise<void> {
  await fs.mkdir(repositoryPath, { recursive: true });
  await execFileAsync('git', ['init', '--quiet'], { cwd: repositoryPath });
}

test('discovery ignores an invalid root marker and returns a valid nested repository', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.mkdir(path.join(workspacePath, '.git'));
    await initRepository(path.join(workspacePath, 'child'));
    const service = new GitRepositoryService(fs, runCommand);

    assert.deepEqual(await service.discover(workspacePath), ['child']);
    assert.equal(await service.resolve(workspacePath, 'child'), path.join(workspacePath, 'child'));
    await assert.rejects(service.resolve(workspacePath, '.'), /not a Git repository/);
  });
});

test('discovery keeps a valid root first and includes independent nested repositories', async () => {
  await withWorkspace(async (workspacePath) => {
    await initRepository(workspacePath);
    await initRepository(path.join(workspacePath, 'nested'));
    const service = new GitRepositoryService(fs, runCommand);

    assert.deepEqual(await service.discover(workspacePath), ['.', 'nested']);
  });
});

test('qualification rejects a marker candidate that is only inside another work tree', async () => {
  await withWorkspace(async (workspacePath) => {
    await initRepository(workspacePath);
    const nestedPath = path.join(workspacePath, 'nested');
    await fs.mkdir(path.join(nestedPath, '.git'), { recursive: true });
    const service = new GitRepositoryService(fs, runCommand);

    assert.deepEqual(await service.discover(workspacePath), ['.']);
    await assert.rejects(service.resolve(workspacePath, 'nested'), /not a Git repository/);
  });
});

test('discovery supports repositories whose .git marker is a file', async () => {
  await withWorkspace(async (workspacePath) => {
    const sourcePath = path.join(workspacePath, 'source');
    const worktreePath = path.join(workspacePath, 'linked');
    await initRepository(sourcePath);
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], {
      cwd: sourcePath,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    });
    await execFileAsync('git', ['worktree', 'add', '--quiet', worktreePath], { cwd: sourcePath });
    assert.equal((await fs.lstat(path.join(worktreePath, '.git'))).isFile(), true);

    const service = new GitRepositoryService(fs, runCommand);
    assert.deepEqual(await service.discover(workspacePath), ['linked', 'source']);
    assert.equal(await service.resolve(workspacePath, 'linked'), worktreePath);
  });
});

test('discovery prunes generated, vendor, cache, build, and VCS metadata trees', async () => {
  await withWorkspace(async (workspacePath) => {
    const prunedDirectories = ['node_modules', 'vendor', 'dist', 'coverage', '.cache', '.next', '.git'];
    for (const directory of prunedDirectories) {
      await initRepository(path.join(workspacePath, directory, 'hidden-repository'));
    }
    await initRepository(path.join(workspacePath, 'packages', 'ordinary-repository'));

    const service = new GitRepositoryService(fs, runCommand);
    assert.deepEqual(await service.discover(workspacePath), ['packages/ordinary-repository']);
  });
});

test('bounded concurrent traversal retains deterministic sorting, deduplication, and symlink safety', async () => {
  await withWorkspace(async (workspacePath) => {
    await Promise.all([
      initRepository(path.join(workspacePath, 'zeta')),
      initRepository(path.join(workspacePath, 'alpha', 'nested')),
      initRepository(path.join(workspacePath, 'middle')),
    ]);
    await fs.symlink(path.join(workspacePath, 'zeta'), path.join(workspacePath, 'linked-zeta'), 'dir');

    let activeReads = 0;
    let maximumActiveReads = 0;
    const trackedFileSystem: Pick<typeof fs, 'lstat' | 'readdir' | 'realpath' | 'stat'> = {
      ...fs,
      readdir: (async (...args: Parameters<typeof fs.readdir>) => {
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await fs.readdir(...args);
        } finally {
          activeReads -= 1;
        }
      }) as typeof fs.readdir,
    };
    const service = new GitRepositoryService(trackedFileSystem, runCommand);

    assert.deepEqual(await service.discover(workspacePath), ['alpha/nested', 'middle', 'zeta']);
    assert.ok(maximumActiveReads > 1);
    assert.ok(maximumActiveReads <= 8);
  });
});
