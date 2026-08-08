import { FolderGit2, RefreshCw } from 'lucide-react';

import type { RepositoryDiscoveryState } from '../utils/repositoryUtils';
import { repositoryDiscoveryMessage, repositoryLabel } from '../utils/repositoryUtils';

type GitRepositorySelectorProps = {
  isMobile: boolean;
  repositories: string[];
  activeRepository: string | null;
  discoveryState: RepositoryDiscoveryState;
  discoveryError: string | null;
  isDiscovering: boolean;
  onRepositoryChange: (repository: string) => void;
  onRediscover: () => void;
};

export default function GitRepositorySelector({
  isMobile,
  repositories,
  activeRepository,
  discoveryState,
  discoveryError,
  isDiscovering,
  onRepositoryChange,
  onRediscover,
}: GitRepositorySelectorProps) {
  const message = repositoryDiscoveryMessage(discoveryState, repositories.length);
  const selectionDisabled = discoveryState !== 'success' || repositories.length === 0;

  return (
    <section className={`border-b border-border/60 ${isMobile ? 'px-3 py-2' : 'px-4 py-3'}`} aria-labelledby="git-repository-label">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label id="git-repository-label" htmlFor="git-repository-select" className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
            <FolderGit2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Repository
          </label>
          <select
            id="git-repository-select"
            value={activeRepository ?? ''}
            onChange={(event) => onRepositoryChange(event.target.value)}
            disabled={selectionDisabled}
            className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {selectionDisabled && <option value="">{message}</option>}
            {repositories.map((repository) => (
              <option key={repository} value={repository}>{repositoryLabel(repository)}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={onRediscover}
          disabled={isDiscovering}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={isDiscovering ? 'Discovering repositories' : 'Rediscover repositories'}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isDiscovering ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>{isDiscovering ? 'Discovering…' : 'Rediscover'}</span>
        </button>
      </div>
      <p className={`mt-1 text-xs ${discoveryState === 'error' ? 'text-destructive' : 'text-muted-foreground'}`} role={discoveryState === 'error' ? 'alert' : 'status'}>
        {message}{discoveryState === 'error' && discoveryError ? `: ${discoveryError}` : ''}
        {discoveryState === 'success' && activeRepository ? ` · Current: ${repositoryLabel(activeRepository)}` : ''}
      </p>
    </section>
  );
}
