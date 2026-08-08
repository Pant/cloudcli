export function selectDiscoveredRepository(
  repositories: string[],
  current: string | null,
): string | null {
  if (current && repositories.includes(current)) return current;
  if (repositories.includes('.')) return '.';
  return repositories[0] ?? null;
}

export function workspaceFilePath(repository: string | null, filePath: string): string {
  if (!repository || repository === '.') return filePath;
  return `${repository.replace(/\/$/, '')}/${filePath.replace(/^\//, '')}`;
}

export function repositoryCacheKey(projectPath: string, repository: string | null): string {
  return `${projectPath}::${repository ?? '.'}`;
}

export type RepositoryDiscoveryState = 'pending' | 'success' | 'error';

export function repositoryLabel(repository: string): string {
  return repository === '.' ? 'Project root' : repository;
}

export function repositoryDiscoveryMessage(
  discoveryState: RepositoryDiscoveryState,
  repositoryCount: number,
): string {
  if (discoveryState === 'pending') return 'Discovering repositories…';
  if (discoveryState === 'error') return 'Repository discovery failed';
  if (repositoryCount === 0) return 'No repositories discovered';
  return `${repositoryCount} ${repositoryCount === 1 ? 'repository' : 'repositories'} discovered`;
}

export function shouldLoadRepositoryStatus(
  discoveryState: RepositoryDiscoveryState,
  activeRepository: string | null,
  repositories: string[],
): boolean {
  return discoveryState === 'success' && (activeRepository !== null || repositories.length === 0);
}

export function canInitializeRepository(
  discoveryState: RepositoryDiscoveryState,
  repositories: string[],
  gitIsNotRepository: boolean,
): boolean {
  return discoveryState === 'success' && repositories.length === 0 && gitIsNotRepository;
}
