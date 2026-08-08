import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { DEFAULT_BRANCH, RECENT_COMMITS_LIMIT } from '../constants/constants';
import type {
  GitApiErrorResponse,
  GitBranchesResponse,
  GitCommitSummary,
  GitCommitsResponse,
  GitDiffMap,
  GitDiffResponse,
  GitFileWithDiffResponse,
  GitGenerateMessageResponse,
  GitOperationResponse,
  GitPanelController,
  GitRepositoriesResponse,
  GitRemoteStatus,
  GitStatusResponse,
  UseGitPanelControllerOptions,
} from '../types/types';
import { getAllChangedFiles } from '../utils/gitPanelUtils';
import {
  selectDiscoveredRepository,
  shouldLoadRepositoryStatus,
  workspaceFilePath,
} from '../utils/repositoryUtils';

import { useSelectedProvider } from './useSelectedProvider';

// ! use authenticatedFetch directly. fetchWithAuth is redundant 
const fetchWithAuth = authenticatedFetch as (url: string, options?: RequestInit) => Promise<Response>;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  const data = (await response.json()) as T;

  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  return data;
}

export function useGitPanelController({
  selectedProject,
  activeView,
  onFileOpen,
}: UseGitPanelControllerOptions): GitPanelController {
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);
  // Separate from `isLoading` (status) so History never flashes "No commits
  // found" while the commits request is still in flight.
  const [isLoadingCommits, setIsLoadingCommits] = useState(false);
  const [hasLoadedCommits, setHasLoadedCommits] = useState(false);
  const [commitDiffs, setCommitDiffs] = useState<GitDiffMap>({});
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCreatingInitialCommit, setIsCreatingInitialCommit] = useState(false);
  const [isInitializingRepository, setIsInitializingRepository] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<string[]>([]);
  const [activeRepository, setActiveRepository] = useState<string | null>(null);
  const [isDiscoveringRepositories, setIsDiscoveringRepositories] = useState(false);
  const [repositoryDiscoveryState, setRepositoryDiscoveryState] = useState<'pending' | 'success' | 'error'>('pending');
  const [repositoryDiscoveryError, setRepositoryDiscoveryError] = useState<string | null>(null);

  const clearOperationError = useCallback(() => setOperationError(null), []);
  // Tracks the DB projectId so async requests can detect stale responses when
  // the user switches projects mid-flight.
  const selectedProjectIdRef = useRef<string | null>(selectedProject?.projectId ?? null);
  const scopeKeyRef = useRef(`${selectedProject?.projectId ?? ''}::${activeRepository ?? ''}`);
  const discoveryRequestRef = useRef(0);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProject?.projectId ?? null;
  }, [selectedProject]);

  useEffect(() => {
    scopeKeyRef.current = `${selectedProject?.projectId ?? ''}::${activeRepository ?? ''}`;
  }, [activeRepository, selectedProject]);

  const repositoryQuery = activeRepository ? `&repository=${encodeURIComponent(activeRepository)}` : '';
  const repositoryBody = useMemo(
    () => (activeRepository ? { repository: activeRepository } : {}),
    [activeRepository],
  );

  const discoverRepositories = useCallback(async (): Promise<string[]> => {
    if (!selectedProject) return [];
    const projectId = selectedProject.projectId;
    const requestId = ++discoveryRequestRef.current;
    setIsDiscoveringRepositories(true);
    setRepositoryDiscoveryState('pending');
    setRepositoryDiscoveryError(null);
    try {
      const response = await fetchWithAuth(`/api/git/repositories?project=${encodeURIComponent(projectId)}`);
      const data = await readJson<GitRepositoriesResponse>(response);
      if (selectedProjectIdRef.current !== projectId || discoveryRequestRef.current !== requestId) return [];
      if (!response.ok || data.error || !Array.isArray(data.repositories)) {
        throw new Error(data.error ?? `Repository discovery failed (${response.status})`);
      }
      const discovered = data.repositories;
      const nextRepository = selectDiscoveredRepository(discovered, activeRepository);
      setRepositories(discovered);
      scopeKeyRef.current = `${projectId}::${nextRepository ?? ''}`;
      setActiveRepository(nextRepository);
      setRepositoryDiscoveryState('success');
      return discovered;
    } catch (error) {
      console.error('Error discovering repositories:', error);
      if (selectedProjectIdRef.current === projectId && discoveryRequestRef.current === requestId) {
        setRepositoryDiscoveryState('error');
        setRepositoryDiscoveryError(error instanceof Error ? error.message : 'Repository discovery failed');
      }
      return [];
    } finally {
      if (selectedProjectIdRef.current === projectId && discoveryRequestRef.current === requestId) setIsDiscoveringRepositories(false);
    }
  }, [activeRepository, selectedProject]);

  const provider = useSelectedProvider();

  const fetchFileDiff = useCallback(
    async (filePath: string, signal?: AbortSignal) => {
      if (!selectedProject) {
        return;
      }

      // Git endpoints receive the DB projectId via the `project` query param.
      const projectId = selectedProject.projectId;

      try {
        const response = await fetchWithAuth(
          `/api/git/diff?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(filePath)}${repositoryQuery}`,
          { signal },
        );
        const data = await readJson<GitDiffResponse>(response, signal);

        if (
          signal?.aborted ||
          scopeKeyRef.current !== `${projectId}::${activeRepository ?? ''}`
        ) {
          return;
        }

        if (!data.error && data.diff) {
          setGitDiff((previous) => ({
            ...previous,
            [filePath]: data.diff as string,
          }));
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        console.error('Error fetching file diff:', error);
      }
    },
    [activeRepository, repositoryQuery, selectedProject],
  );

  const fetchGitStatus = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject) {
      return;
    }

    // `project` query param carries the DB projectId everywhere now.
    const projectId = selectedProject.projectId;

    setIsLoading(true);
    try {
      const response = await fetchWithAuth(`/api/git/status?project=${encodeURIComponent(projectId)}${repositoryQuery}`, { signal });
      const data = await readJson<GitStatusResponse>(response, signal);

      if (
        signal?.aborted ||
        scopeKeyRef.current !== `${projectId}::${activeRepository ?? ''}`
      ) {
        return;
      }

      if (data.error) {
        // A missing repository is an expected state, not an error.
        if (!data.notGitRepository) {
          console.error('Git status error:', data.error);
        }
        setGitStatus({
          error: data.error,
          details: data.details,
          notGitRepository: data.notGitRepository,
        });
        setCurrentBranch('');
        return;
      }

      setGitStatus(data);
      setCurrentBranch(data.branch || DEFAULT_BRANCH);

      const changedFiles = getAllChangedFiles(data);
      changedFiles.forEach((filePath) => {
        void fetchFileDiff(filePath, signal);
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }

      if (
        scopeKeyRef.current !== `${projectId}::${activeRepository ?? ''}`
      ) {
        return;
      }

      console.error('Error fetching git status:', error);
      setGitStatus({ error: 'Git operation failed', details: String(error) });
      setCurrentBranch('');
    } finally {
      if (scopeKeyRef.current === `${projectId}::${activeRepository ?? ''}`) setIsLoading(false);
    }
  }, [activeRepository, fetchFileDiff, repositoryQuery, selectedProject]);

  const fetchBranches = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    const projectId = selectedProject.projectId;
    const requestScope = `${projectId}::${activeRepository ?? ''}`;
    try {
      const response = await fetchWithAuth(`/api/git/branches?project=${encodeURIComponent(projectId)}${repositoryQuery}`);
      const data = await readJson<GitBranchesResponse>(response);
      if (scopeKeyRef.current !== requestScope) return;

      if (!data.error && data.branches) {
        setBranches(data.branches);
        setLocalBranches(data.localBranches ?? data.branches);
        setRemoteBranches(data.remoteBranches ?? []);
        return;
      }

      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    } catch (error) {
      if (scopeKeyRef.current !== requestScope) return;
      console.error('Error fetching branches:', error);
      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    }
  }, [activeRepository, repositoryQuery, selectedProject]);

  const fetchRemoteStatus = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    const projectId = selectedProject.projectId;
    const requestScope = `${projectId}::${activeRepository ?? ''}`;
    try {
      const response = await fetchWithAuth(`/api/git/remote-status?project=${encodeURIComponent(projectId)}${repositoryQuery}`);
      const data = await readJson<GitRemoteStatus | GitApiErrorResponse>(response);
      if (scopeKeyRef.current !== requestScope) return;

      if (!data.error) {
        setRemoteStatus(data as GitRemoteStatus);
        return;
      }

      setRemoteStatus(null);
    } catch (error) {
      if (scopeKeyRef.current !== requestScope) return;
      console.error('Error fetching remote status:', error);
      setRemoteStatus(null);
    }
  }, [activeRepository, repositoryQuery, selectedProject]);

  const switchBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) {
        return false;
      }

      try {
        const response = await fetchWithAuth('/api/git/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            ...repositoryBody,
            branch: branchName,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          console.error('Failed to switch branch:', data.error);
          return false;
        }

        setCurrentBranch(branchName);
        void fetchGitStatus();
        return true;
      } catch (error) {
        console.error('Error switching branch:', error);
        return false;
      }
    },
    [fetchGitStatus, repositoryBody, selectedProject],
  );

  const createBranch = useCallback(
    async (branchName: string) => {
      const trimmedBranchName = branchName.trim();
      if (!selectedProject || !trimmedBranchName) {
        return false;
      }

      setIsCreatingBranch(true);
      try {
        const response = await fetchWithAuth('/api/git/create-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            ...repositoryBody,
            branch: trimmedBranchName,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          console.error('Failed to create branch:', data.error);
          return false;
        }

        setCurrentBranch(trimmedBranchName);
        void fetchBranches();
        void fetchGitStatus();
        return true;
      } catch (error) {
        console.error('Error creating branch:', error);
        return false;
      } finally {
        setIsCreatingBranch(false);
      }
    },
    [fetchBranches, fetchGitStatus, repositoryBody, selectedProject],
  );

  const deleteBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) return false;

      try {
        const response = await fetchWithAuth('/api/git/delete-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: selectedProject.projectId, ...repositoryBody, branch: branchName }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Delete branch failed');
          return false;
        }

        void fetchBranches();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Delete branch failed');
        return false;
      }
    },
    [fetchBranches, repositoryBody, selectedProject],
  );

  const handleFetch = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsFetching(true);
    try {
      const response = await fetchWithAuth('/api/git/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          ...repositoryBody,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        void fetchBranches();
        return;
      }

      setOperationError(data.error ?? 'Fetch failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Fetch failed');
    } finally {
      setIsFetching(false);
    }
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, repositoryBody, selectedProject]);

  const handlePull = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPulling(true);
    try {
      const response = await fetchWithAuth('/api/git/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          ...repositoryBody,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? 'Pull failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Pull failed');
    } finally {
      setIsPulling(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, repositoryBody, selectedProject]);

  const handlePush = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPushing(true);
    try {
      const response = await fetchWithAuth('/api/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          ...repositoryBody,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? 'Push failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Push failed');
    } finally {
      setIsPushing(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, repositoryBody, selectedProject]);

  const handlePublish = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPublishing(true);
    try {
      const response = await fetchWithAuth('/api/git/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          ...repositoryBody,
          branch: currentBranch,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      console.error('Publish failed:', data.error);
    } catch (error) {
      console.error('Error publishing branch:', error);
    } finally {
      setIsPublishing(false);
    }
  }, [currentBranch, fetchGitStatus, fetchRemoteStatus, repositoryBody, selectedProject]);

  const discardChanges = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchWithAuth('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            ...repositoryBody,
            file: filePath,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Discard failed:', data.error);
      } catch (error) {
        console.error('Error discarding changes:', error);
      }
    },
    [fetchGitStatus, repositoryBody, selectedProject],
  );

  const deleteUntrackedFile = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchWithAuth('/api/git/delete-untracked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            ...repositoryBody,
            file: filePath,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Delete failed:', data.error);
      } catch (error) {
        console.error('Error deleting untracked file:', error);
      }
    },
    [fetchGitStatus, repositoryBody, selectedProject],
  );

  const stageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }

      try {
        const response = await fetchWithAuth('/api/git/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            ...repositoryBody,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Stage failed');
          return false;
        }

        // Refresh so the Staged section re-syncs from the real index.
        await fetchGitStatus();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Stage failed');
        return false;
      }
    },
    [fetchGitStatus, repositoryBody, selectedProject],
  );

  const unstageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }

      try {
        const response = await fetchWithAuth('/api/git/unstage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            ...repositoryBody,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Unstage failed');
          return false;
        }

        await fetchGitStatus();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Unstage failed');
        return false;
      }
    },
    [fetchGitStatus, repositoryBody, selectedProject],
  );

  const fetchRecentCommits = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    const projectId = selectedProject.projectId;
    const requestScope = `${projectId}::${activeRepository ?? ''}`;

    setIsLoadingCommits(true);
    try {
      const response = await fetchWithAuth(
        `/api/git/commits?project=${encodeURIComponent(projectId)}&limit=${RECENT_COMMITS_LIMIT}${repositoryQuery}`,
      );
      const data = await readJson<GitCommitsResponse>(response);

      if (scopeKeyRef.current !== requestScope) {
        return;
      }

      if (!data.error && data.commits) {
        setRecentCommits(data.commits);
      }
    } catch (error) {
      console.error('Error fetching commits:', error);
    } finally {
      if (scopeKeyRef.current === requestScope) {
        setIsLoadingCommits(false);
        setHasLoadedCommits(true);
      }
    }
  }, [activeRepository, repositoryQuery, selectedProject]);

  const fetchCommitDiff = useCallback(
    async (commitHash: string) => {
      if (!selectedProject) {
        return;
      }

      const requestScope = `${selectedProject.projectId}::${activeRepository ?? ''}`;
      try {
        const response = await fetchWithAuth(
          `/api/git/commit-diff?project=${encodeURIComponent(selectedProject.projectId)}&commit=${commitHash}${repositoryQuery}`,
        );
        const data = await readJson<GitDiffResponse>(response);
        if (scopeKeyRef.current !== requestScope) return;

        if (!data.error && data.diff) {
          setCommitDiffs((previous) => ({
            ...previous,
            [commitHash]: data.diff as string,
          }));
        }
      } catch (error) {
        console.error('Error fetching commit diff:', error);
      }
    },
    [activeRepository, repositoryQuery, selectedProject],
  );

  const generateCommitMessage = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return null;
      }

      try {
        const response = await authenticatedFetch('/api/git/generate-commit-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            ...repositoryBody,
            files,
            provider,
          }),
        });

        const data = await readJson<GitGenerateMessageResponse>(response);
        if (data.message) {
          return data.message;
        }

        console.error('Failed to generate commit message:', data.error);
        return null;
      } catch (error) {
        console.error('Error generating commit message:', error);
        return null;
      }
    },
    [provider, repositoryBody, selectedProject],
  );

  const commitChanges = useCallback(
    async (message: string, files: string[]) => {
      if (!selectedProject || !message.trim() || files.length === 0) {
        return false;
      }

      try {
        const response = await fetchWithAuth('/api/git/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            ...repositoryBody,
            message,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          void fetchRemoteStatus();
          return true;
        }

        console.error('Commit failed:', data.error);
        return false;
      } catch (error) {
        console.error('Error committing changes:', error);
        return false;
      }
    },
    [fetchGitStatus, fetchRemoteStatus, repositoryBody, selectedProject],
  );

  const createInitialCommit = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('No project selected');
    }

    setIsCreatingInitialCommit(true);
    try {
      const response = await fetchWithAuth('/api/git/initial-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          ...repositoryBody,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return true;
      }

      throw new Error(data.error || 'Failed to create initial commit');
    } catch (error) {
      console.error('Error creating initial commit:', error);
      throw error;
    } finally {
      setIsCreatingInitialCommit(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, repositoryBody, selectedProject]);

  const initRepository = useCallback(async () => {
    if (!selectedProject) {
      return false;
    }
    const projectId = selectedProject.projectId;

    setIsInitializingRepository(true);
    try {
      const response = await fetchWithAuth('/api/git/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: projectId,
          repository: '.',
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (selectedProjectIdRef.current !== projectId) {
        return false;
      }
      if (!data.success) {
        setOperationError(data.error ?? 'Failed to initialize repository');
        return false;
      }

      const discovered = await discoverRepositories();
      if (discovered.includes('.')) setActiveRepository('.');
      return true;
    } catch (error) {
      if (selectedProjectIdRef.current === projectId) {
        setOperationError(error instanceof Error ? error.message : 'Failed to initialize repository');
      }
      return false;
    } finally {
      setIsInitializingRepository(false);
    }
  }, [discoverRepositories, selectedProject]);

  const openFile = useCallback(
    async (filePath: string) => {
      if (!onFileOpen) {
        return;
      }

      if (!selectedProject) {
        onFileOpen(filePath);
        return;
      }

      try {
        const response = await fetchWithAuth(
          `/api/git/file-with-diff?project=${encodeURIComponent(selectedProject.projectId)}&file=${encodeURIComponent(filePath)}${repositoryQuery}`,
        );
        const data = await readJson<GitFileWithDiffResponse>(response);

        if (data.error) {
          console.error('Error fetching file with diff:', data.error);
          onFileOpen(workspaceFilePath(activeRepository, filePath));
          return;
        }

        onFileOpen(workspaceFilePath(activeRepository, filePath), {
          old_string: data.oldContent || '',
          new_string: data.currentContent || '',
        });
      } catch (error) {
        console.error('Error opening file:', error);
        onFileOpen(workspaceFilePath(activeRepository, filePath));
      }
    },
    [activeRepository, onFileOpen, repositoryQuery, selectedProject],
  );

  const refreshAll = useCallback(() => {
    void discoverRepositories();
  }, [discoverRepositories]);

  useEffect(() => {
    const controller = new AbortController();

    // Reset repository-scoped state when project changes to avoid stale UI.
    setCurrentBranch('');
    setBranches([]);
    setLocalBranches([]);
    setRemoteBranches([]);
    setGitStatus(null);
    setRemoteStatus(null);
    setGitDiff({});
    setRecentCommits([]);
    setCommitDiffs({});
    setIsLoading(false);
    setIsLoadingCommits(false);
    setHasLoadedCommits(false);
    setOperationError(null);

    if (!selectedProject || !shouldLoadRepositoryStatus(repositoryDiscoveryState, activeRepository, repositories)) {
      return () => {
        controller.abort();
      };
    }

    void fetchGitStatus(controller.signal);
    if (activeRepository) {
      void fetchBranches();
      void fetchRemoteStatus();
    }

    return () => {
      controller.abort();
    };
  }, [activeRepository, fetchBranches, fetchGitStatus, fetchRemoteStatus, repositories, repositoryDiscoveryState, selectedProject]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProject?.projectId ?? null;
    discoveryRequestRef.current += 1;
    setRepositories([]);
    setActiveRepository(null);
    scopeKeyRef.current = `${selectedProject?.projectId ?? ''}::`;
    setRepositoryDiscoveryState('pending');
    setRepositoryDiscoveryError(null);
    if (selectedProject) void discoverRepositories();
    // Discovery is intentionally keyed only by project; rediscovery is invoked explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject?.projectId]);

  useEffect(() => {
    if (!selectedProject || activeView !== 'history') {
      return;
    }
    void fetchRecentCommits();
  }, [activeView, fetchRecentCommits, selectedProject]);

  return {
    repositories,
    activeRepository,
    isDiscoveringRepositories,
    repositoryDiscoveryState,
    repositoryDiscoveryError,
    selectRepository: (repository) => {
      scopeKeyRef.current = `${selectedProject?.projectId ?? ''}::${repository}`;
      setActiveRepository(repository);
    },
    discoverRepositories,
    gitStatus,
    gitDiff,
    isLoading,
    // History is "loading" until the first commits response for this project
    // lands, so an empty list never renders before the data exists.
    isLoadingCommits: isLoadingCommits || !hasLoadedCommits,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    recentCommits,
    commitDiffs,
    remoteStatus,
    isCreatingBranch,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    isInitializingRepository,
    operationError,
    clearOperationError,
    refreshAll,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    stageFiles,
    unstageFiles,
    fetchCommitDiff,
    generateCommitMessage,
    commitChanges,
    createInitialCommit,
    initRepository,
    openFile,
  };
}
