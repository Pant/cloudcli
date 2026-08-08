import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type {
  MergeWorktreeOptions,
  RemoveWorktreeOptions,
  WorktreeApiEnvelope,
  WorktreeListData,
} from '../types/types';

type UseWorktreesControllerOptions = {
  selectedProject: Project | null;
  repository: string;
  onProjectSelect?: (project: Project) => void;
  onProjectsRefresh?: () => void;
};

type WorktreeProjectPayload = {
  project?: Project;
};

function readEnvelopeError<TData>(payload: WorktreeApiEnvelope<TData>, fallback: string): string {
  const message = payload.error?.message || fallback;
  const details = payload.error?.details;

  if (Array.isArray(details) && details.length > 0) {
    return `${message}: ${details.slice(0, 5).join(', ')}${details.length > 5 ? ', …' : ''}`;
  }

  if (typeof details === 'string' && details.trim()) {
    return `${message}: ${details.trim()}`;
  }

  return message;
}

export function useWorktreesController({
  selectedProject,
  repository,
  onProjectSelect,
  onProjectsRefresh,
}: UseWorktreesControllerOptions) {
  const [worktreeData, setWorktreeData] = useState<WorktreeListData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isCreatingWorktree, setIsCreatingWorktree] = useState(false);
  /** Path of the worktree with an open/merge/remove request in flight (one at a time). */
  const [busyWorktreePath, setBusyWorktreePath] = useState<string | null>(null);
  const activeWorktreeOperationRef = useRef<symbol | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const clearActionError = useCallback(() => setActionError(null), []);

  // Detects stale responses after the user switches projects mid-request.
  const selectedProjectIdRef = useRef<string | null>(selectedProject?.projectId ?? null);
  const scopeKeyRef = useRef(`${selectedProject?.projectId ?? ''}::${repository}`);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProject?.projectId ?? null;
    scopeKeyRef.current = `${selectedProject?.projectId ?? ''}::${repository}`;
  }, [repository, selectedProject]);

  const fetchWorktrees = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    const projectId = selectedProject.projectId;
    setIsLoading(true);
    try {
      const response = await authenticatedFetch(
        `/api/worktrees?project=${encodeURIComponent(projectId)}&repository=${encodeURIComponent(repository)}`,
      );
      const payload = (await response.json()) as WorktreeApiEnvelope<WorktreeListData>;

      if (scopeKeyRef.current !== `${projectId}::${repository}`) {
        return;
      }

      if (!response.ok || !payload.data) {
        // A plain directory (no repository) is an expected state for the
        // Worktrees tab — the panel-level error state already covers it.
        setWorktreeData(null);
        return;
      }

      setWorktreeData(payload.data);
    } catch (error) {
      console.error('Error fetching worktrees:', error);
      if (selectedProjectIdRef.current === projectId) {
        setWorktreeData(null);
      }
    } finally {
      if (selectedProjectIdRef.current === projectId) {
        setIsLoading(false);
        setHasLoaded(true);
      }
    }
  }, [repository, selectedProject]);

  useEffect(() => {
    setWorktreeData(null);
    setHasLoaded(false);
    setActionError(null);
    void fetchWorktrees();
  }, [fetchWorktrees]);

  const createWorktree = useCallback(
    async (branch: string, baseBranch: string | null, openAfterCreate: boolean) => {
      const trimmedBranch = branch.trim();
      if (!selectedProject || !trimmedBranch) {
        return false;
      }
      const projectId = selectedProject.projectId;

      setIsCreatingWorktree(true);
      setActionError(null);
      try {
        const response = await authenticatedFetch('/api/worktrees/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: projectId,
            repository,
            branch: trimmedBranch,
            baseBranch,
          }),
        });
        const payload = (await response.json()) as WorktreeApiEnvelope<WorktreeProjectPayload>;

        if (selectedProjectIdRef.current !== projectId) {
          return false;
        }

        if (!response.ok || !payload.data) {
          setActionError(readEnvelopeError(payload, 'Failed to create worktree'));
          return false;
        }

        onProjectsRefresh?.();
        if (openAfterCreate && payload.data.project && onProjectSelect) {
          onProjectSelect(payload.data.project);
        } else {
          void fetchWorktrees();
        }
        return true;
      } catch (error) {
        if (selectedProjectIdRef.current === projectId) {
          setActionError(error instanceof Error ? error.message : 'Failed to create worktree');
        }
        return false;
      } finally {
        setIsCreatingWorktree(false);
      }
    },
    [fetchWorktrees, onProjectSelect, onProjectsRefresh, repository, selectedProject],
  );

  const openWorktree = useCallback(
    async (worktreePath: string) => {
      if (!selectedProject || activeWorktreeOperationRef.current !== null) {
        return false;
      }
      const projectId = selectedProject.projectId;
      const operationToken = Symbol('open-worktree');
      activeWorktreeOperationRef.current = operationToken;

      setBusyWorktreePath(worktreePath);
      setActionError(null);
      try {
        const response = await authenticatedFetch('/api/worktrees/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: projectId,
            repository,
            worktreePath,
          }),
        });
        const payload = (await response.json()) as WorktreeApiEnvelope<WorktreeProjectPayload>;

        if (selectedProjectIdRef.current !== projectId) {
          return false;
        }

        if (!response.ok || !payload.data?.project) {
          setActionError(readEnvelopeError(payload, 'Failed to open worktree'));
          return false;
        }

        onProjectsRefresh?.();
        onProjectSelect?.(payload.data.project);
        return true;
      } catch (error) {
        if (selectedProjectIdRef.current === projectId) {
          setActionError(error instanceof Error ? error.message : 'Failed to open worktree');
        }
        return false;
      } finally {
        if (activeWorktreeOperationRef.current === operationToken) {
          activeWorktreeOperationRef.current = null;
          setBusyWorktreePath(null);
        }
      }
    },
    [onProjectSelect, onProjectsRefresh, repository, selectedProject],
  );

  const mergeWorktree = useCallback(
    async (worktreePath: string, options: MergeWorktreeOptions) => {
      if (!selectedProject || activeWorktreeOperationRef.current !== null) {
        return false;
      }
      const operationToken = Symbol('merge-worktree');
      activeWorktreeOperationRef.current = operationToken;

      setBusyWorktreePath(worktreePath);
      setActionError(null);
      try {
        const response = await authenticatedFetch('/api/worktrees/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            repository,
            worktreePath,
            squash: options.squash,
            message: options.message,
            removeAfterMerge: options.removeAfterMerge,
          }),
        });
        const payload = (await response.json()) as WorktreeApiEnvelope<unknown>;

        if (!response.ok || !payload.success) {
          setActionError(readEnvelopeError(payload, 'Merge failed'));
          return false;
        }

        onProjectsRefresh?.();
        void fetchWorktrees();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Merge failed');
        return false;
      } finally {
        if (activeWorktreeOperationRef.current === operationToken) {
          activeWorktreeOperationRef.current = null;
          setBusyWorktreePath(null);
        }
      }
    },
    [fetchWorktrees, onProjectsRefresh, repository, selectedProject],
  );

  const removeWorktree = useCallback(
    async (worktreePath: string, options: RemoveWorktreeOptions) => {
      if (!selectedProject || activeWorktreeOperationRef.current !== null) {
        return false;
      }
      const operationToken = Symbol('remove-worktree');
      activeWorktreeOperationRef.current = operationToken;

      setBusyWorktreePath(worktreePath);
      setActionError(null);
      try {
        const response = await authenticatedFetch('/api/worktrees/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            repository,
            worktreePath,
            force: options.force,
            deleteBranch: options.deleteBranch,
          }),
        });
        const payload = (await response.json()) as WorktreeApiEnvelope<unknown>;

        if (!response.ok || !payload.success) {
          setActionError(readEnvelopeError(payload, 'Failed to remove worktree'));
          return false;
        }

        onProjectsRefresh?.();
        void fetchWorktrees();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Failed to remove worktree');
        return false;
      } finally {
        if (activeWorktreeOperationRef.current === operationToken) {
          activeWorktreeOperationRef.current = null;
          setBusyWorktreePath(null);
        }
      }
    },
    [fetchWorktrees, onProjectsRefresh, repository, selectedProject],
  );

  return {
    worktreeData,
    // "Loading" until the first response lands so the empty state never
    // flashes before the data exists (same pattern as the History view).
    isLoading: isLoading || !hasLoaded,
    isCreatingWorktree,
    busyWorktreePath,
    actionError,
    clearActionError,
    refreshWorktrees: fetchWorktrees,
    createWorktree,
    openWorktree,
    mergeWorktree,
    removeWorktree,
  };
}
