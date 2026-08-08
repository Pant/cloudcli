import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeGeneration, FileTreeNode } from '../types/types';
import {
  createRecentProjectFileTreeCache,
  findFileTreeNode,
  replaceDirectoryChildren,
  replaceRootChildrenPreservingLoadedBranches,
} from '../utils/fileTreeUtils';
import {
  advanceExplorerRequestGeneration,
  createExplorerDirectoryRequestPlan,
  createExplorerRequestGeneration,
  FileTreeInFlightRequests,
  FileTreeSnapshotRequest,
  getCachedFileTreeInitialState,
  planLoadedBranchRefresh,
} from '../utils/fileTreeRequestUtils';

const recentProjectCache = createRecentProjectFileTreeCache<FileTreeNode[]>(3);

type FileTreeState = {
  projectId?: string;
  files: FileTreeNode[];
  loading: boolean;
};

export type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  generation: FileTreeGeneration | null;
  directoryLoading: Set<string>;
  loadDirectory: (path: string) => Promise<void>;
  loadCompleteTree: () => Promise<FileTreeNode[]>;
  refreshFiles: () => void;
};

type FileTreeResponse = {
  response: Response;
  data?: FileTreeNode[];
};

function getRequestKey(targetPath?: string): string {
  return targetPath || '__root__';
}

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const initialProjectId = selectedProject?.projectId;
  const initialState = getCachedFileTreeInitialState(initialProjectId, (projectId) => recentProjectCache.get(projectId));
  const [state, setState] = useState<FileTreeState>(() => ({
    projectId: initialProjectId,
    files: initialState.files,
    loading: Boolean(initialProjectId && !initialState.hasCachedTree),
  }));
  const [directoryLoading, setDirectoryLoading] = useState<Set<string>>(() => new Set());

  const filesRef = useRef<FileTreeNode[]>(initialState.files);
  const projectIdRef = useRef<string | undefined>(initialProjectId);
  const generationRef = useRef<FileTreeGeneration | null>(
    initialProjectId ? createExplorerRequestGeneration(initialProjectId) : null,
  );
  const inFlightRef = useRef(new FileTreeInFlightRequests<FileTreeResponse>());
  const completeTreeRef = useRef(new FileTreeSnapshotRequest<FileTreeNode[]>());
  const controllersRef = useRef(new Map<string, AbortController>());

  const abortRequests = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    inFlightRef.current.clear();
  }, []);

  const isCurrentGeneration = useCallback((generation: FileTreeGeneration): boolean => {
    const current = generationRef.current;
    return Boolean(
      current
      && current.projectId === generation.projectId
      && current.generation === generation.generation,
    );
  }, []);

  const setFilesForGeneration = useCallback(
    (generation: FileTreeGeneration, update: (files: FileTreeNode[]) => FileTreeNode[]) => {
      if (!isCurrentGeneration(generation)) {
        return;
      }

      setState((previous) => {
        if (previous.projectId !== generation.projectId) {
          return previous;
        }

        const nextFiles = update(previous.files);
        filesRef.current = nextFiles;
        recentProjectCache.set(generation.projectId, nextFiles);
        return { ...previous, files: nextFiles, loading: false };
      });
    },
    [isCurrentGeneration],
  );

  const requestDirectory = useCallback(
    (targetPath: string | undefined, generation: FileTreeGeneration): Promise<void> => {
      const projectId = generation.projectId;
      const requestKey = getRequestKey(targetPath);
      const plan = createExplorerDirectoryRequestPlan(targetPath);
      const isRoot = targetPath === undefined;

      setDirectoryLoading((previous) => {
        if (!isRoot && previous.has(targetPath)) {
          return previous;
        }
        const next = new Set(previous);
        if (!isRoot) {
          next.add(targetPath);
        }
        return next;
      });

      const request = inFlightRef.current.getOrCreate(requestKey, generation, async () => {
        const controller = new AbortController();
        controllersRef.current.set(requestKey, controller);
        try {
          const response = await api.getFiles(projectId, {
            ...plan,
            signal: controller.signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`File fetch failed: ${response.status} ${errorText}`);
          }

          return {
            response,
            data: (await response.json()) as FileTreeNode[],
          };
        } finally {
          if (controllersRef.current.get(requestKey) === controller) {
            controllersRef.current.delete(requestKey);
          }
        }
      });

      return request.then(({ data }) => {
        if (!data || !isCurrentGeneration(generation)) {
          return;
        }

        setFilesForGeneration(generation, (files) => {
          if (isRoot) {
            return replaceRootChildrenPreservingLoadedBranches(files, data);
          }

          // A directory may have been removed by a concurrent root refresh;
          // in that case the immutable helper safely leaves the root alone.
          return replaceDirectoryChildren(files, targetPath, data);
        });
      }).catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError' && isCurrentGeneration(generation)) {
          console.error('Error fetching files:', error);
        }
      }).finally(() => {
        if (!isCurrentGeneration(generation)) {
          return;
        }
        setDirectoryLoading((previous) => {
          if (isRoot || !previous.has(targetPath)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(targetPath);
          return next;
        });
        if (isRoot && isCurrentGeneration(generation)) {
          setState((previous) => previous.projectId === projectId ? { ...previous, loading: false } : previous);
        }
      });
    },
    [isCurrentGeneration, setFilesForGeneration],
  );

  const loadDirectory = useCallback(
    (path: string): Promise<void> => {
      const projectId = projectIdRef.current;
      const generation = generationRef.current;
      if (!projectId || !generation) {
        return Promise.resolve();
      }

      const node = findFileTreeNode(filesRef.current, path);
      if (!node || node.type !== 'directory' || node.children !== undefined) {
        return Promise.resolve();
      }

      return requestDirectory(path, generation);
    },
    [requestDirectory],
  );

  const refreshFiles = useCallback(() => {
    const projectId = projectIdRef.current;
    const previousGeneration = generationRef.current;
    if (!projectId || !previousGeneration) {
      return;
    }

    const plans = planLoadedBranchRefresh(filesRef.current);
    const generation = advanceExplorerRequestGeneration(previousGeneration, projectId);
    generationRef.current = generation;
    completeTreeRef.current.invalidate();
    abortRequests();
    setDirectoryLoading(new Set(plans.flatMap((plan) => plan.targetPath ? [plan.targetPath] : [])));
    setState((previous) => previous.projectId === projectId
      ? { ...previous, loading: previous.files.length === 0 }
      : previous);

    plans.forEach((plan) => {
      void requestDirectory(plan.targetPath, generation);
    });
  }, [abortRequests, requestDirectory]);

  const loadCompleteTree = useCallback((): Promise<FileTreeNode[]> => {
    const projectId = projectIdRef.current;
    const generation = generationRef.current;
    if (!projectId || !generation) {
      return Promise.reject(new Error('No project selected'));
    }

    return completeTreeRef.current.getOrCreate(generation, async () => {
      const response = await api.getFiles(projectId, {
        depth: 10,
        includeMetadata: true,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Complete file fetch failed: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as FileTreeNode[];
      if (!isCurrentGeneration(generation)) {
        throw new Error('Complete file fetch became stale');
      }
      return data;
    });
  }, [isCurrentGeneration]);

  useEffect(() => {
    const projectId = selectedProject?.projectId;
    abortRequests();
    completeTreeRef.current.invalidate();

    if (!projectId) {
      projectIdRef.current = undefined;
      generationRef.current = null;
      filesRef.current = [];
      setState({ projectId: undefined, files: [], loading: false });
      setDirectoryLoading(new Set());
      return () => {
        abortRequests();
      };
    }

    const generation = generationRef.current?.projectId === projectId
      ? advanceExplorerRequestGeneration(generationRef.current, projectId)
      : createExplorerRequestGeneration(projectId);
    generationRef.current = generation;
    projectIdRef.current = projectId;

    const cached = recentProjectCache.get(projectId);
    const hydratedFiles = cached ?? [];
    const hasCachedTree = cached !== undefined;
    filesRef.current = hydratedFiles;
    setState({
      projectId,
      files: hydratedFiles,
      // A cached tree must remain visible while its root is revalidated.
      loading: !hasCachedTree,
    });
    setDirectoryLoading(new Set());

    // Revalidation is intentionally root-only; explicit refresh reconciles
    // every loaded branch through planLoadedBranchRefresh.
    void requestDirectory(undefined, generation);

    return () => {
      abortRequests();
    };
  }, [abortRequests, requestDirectory, selectedProject?.projectId]);

  const projectId = selectedProject?.projectId;
  const cachedForRender = projectId ? recentProjectCache.get(projectId) : undefined;
  const isStateForProject = state.projectId === projectId;

  return {
    files: isStateForProject ? state.files : cachedForRender ?? [],
    loading: isStateForProject ? state.loading : !cachedForRender,
    generation: isStateForProject ? generationRef.current : null,
    directoryLoading,
    loadDirectory,
    loadCompleteTree,
    refreshFiles,
  };
}
