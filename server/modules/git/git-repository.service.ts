import path from 'node:path';
import type { Dirent } from 'node:fs';

import { AppError, resolveWorkspaceRelativePath } from '@/shared/utils.js';

type GitRepositoryFileSystem = Pick<typeof import('node:fs/promises'), 'lstat' | 'readdir' | 'realpath' | 'stat'>;
type RunCommand = (command: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

const DISCOVERY_CONCURRENCY = 8;
const PRUNED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.git',
  '.gradle',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.pnpm-store',
  '.svn',
  '.turbo',
  '.yarn',
  '__pycache__',
  'bower_components',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

/** Filesystem service used by the Git router for safe repository discovery and targeting. */
export class GitRepositoryService {
  constructor(
    private readonly fileSystem: GitRepositoryFileSystem,
    private readonly runCommand: RunCommand,
  ) {}

  async resolve(workspacePath: string, selector: unknown, options: { allowUninitialized?: boolean } = {}): Promise<string> {
    const resolved = await resolveWorkspaceRelativePath(workspacePath, selector);
    if (resolved.selector === undefined) return resolved.path;
    if (options.allowUninitialized) return resolved.path;
    if (!(await this.isGitWorkTreeRoot(resolved.path))) {
      throw new AppError('Selected path is not a Git repository', { code: 'INVALID_REPOSITORY', statusCode: 400 });
    }
    return resolved.path;
  }

  async discover(workspacePath: string): Promise<string[]> {
    const workspaceRealPath = await this.fileSystem.realpath(path.resolve(workspacePath));
    const repositories = new Map<string, string>();
    const visit = async (directoryPath: string): Promise<string[]> => {
      if (await this.hasGitMarker(directoryPath) && await this.isGitWorkTreeRoot(directoryPath)) {
        const repositoryRealPath = await this.fileSystem.realpath(directoryPath);
        const relativePath = path.relative(workspaceRealPath, repositoryRealPath).replace(/\\/g, '/') || '.';
        repositories.set(repositoryRealPath, relativePath);
      }
      let entries: Dirent[];
      try { entries = await this.fileSystem.readdir(directoryPath, { withFileTypes: true }); } catch { return []; }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      return entries
        .filter((entry) => !PRUNED_DIRECTORY_NAMES.has(entry.name) && entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => path.join(directoryPath, entry.name));
    };

    let pendingDirectories = [workspaceRealPath];
    while (pendingDirectories.length > 0) {
      const nextDirectories: string[] = [];
      for (let index = 0; index < pendingDirectories.length; index += DISCOVERY_CONCURRENCY) {
        const batch = pendingDirectories.slice(index, index + DISCOVERY_CONCURRENCY);
        const children = await Promise.all(batch.map(visit));
        nextDirectories.push(...children.flat());
      }
      pendingDirectories = nextDirectories;
    }
    return [...repositories.values()].sort((left, right) => left === '.' ? -1 : right === '.' ? 1 : left.localeCompare(right));
  }

  private async hasGitMarker(directoryPath: string): Promise<boolean> {
    try {
      const marker = await this.fileSystem.lstat(path.join(directoryPath, '.git'));
      return marker.isDirectory() || marker.isFile();
    } catch { return false; }
  }

  private async isGitWorkTreeRoot(directoryPath: string): Promise<boolean> {
    try {
      const candidateRealPath = await this.fileSystem.realpath(directoryPath);
      const { stdout } = await this.runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: candidateRealPath });
      const workTreeRoot = stdout.trim();
      if (!workTreeRoot) return false;
      return await this.fileSystem.realpath(workTreeRoot) === candidateRealPath;
    } catch {
      return false;
    }
  }
}
