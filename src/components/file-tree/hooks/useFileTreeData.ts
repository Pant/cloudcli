import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeGeneration, FileTreeNode, FileTreePageResponse, FileTreePageState } from '../types/types';
import {
  appendDirectoryChildren,
  createRecentProjectFileTreeCache,
  findFileTreeNode,
  reconcileFileTreeMetadata,
  replaceDirectoryChildren,
  replaceRootChildrenPreservingLoadedBranches,
} from '../utils/fileTreeUtils';
import {
  advanceExplorerRequestGeneration,
  createExplorerDirectoryRequestPlan,
  createExplorerMetadataRequestPlan,
  createExplorerRequestGeneration,
  FileTreeInFlightRequests,
  FileTreeSnapshotRequest,
  getCachedFileTreeInitialState,
  planLoadedBranchRefresh,
} from '../utils/fileTreeRequestUtils';

const recentProjectCache = createRecentProjectFileTreeCache<FileTreeNode[]>(3);
const recentPageStateCache = createRecentProjectFileTreeCache<Map<string, FileTreePageState>>(3);

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
  pageState: Map<string, FileTreePageState>;
  loadDirectory: (path: string) => Promise<void>;
  loadNextPage: (path?: string) => Promise<void>;
  loadCompleteTree: () => Promise<FileTreeNode[]>;
  refreshFiles: () => void;
};

type FileTreeResponse = {
  response: Response;
  data?: FileTreePageResponse;
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
  const [pageState, setPageState] = useState<Map<string, FileTreePageState>>(
    () => initialProjectId ? recentPageStateCache.get(initialProjectId) ?? new Map() : new Map(),
  );

  const filesRef = useRef<FileTreeNode[]>(initialState.files);
  const projectIdRef = useRef<string | undefined>(initialProjectId);
  const generationRef = useRef<FileTreeGeneration | null>(
    initialProjectId ? createExplorerRequestGeneration(initialProjectId) : null,
  );
  const pageStateRef = useRef(pageState);
  const inFlightRef = useRef(new FileTreeInFlightRequests<FileTreeResponse>());
  const metadataInFlightRef = useRef(new FileTreeInFlightRequests<FileTreeResponse>());
  const completeTreeRef = useRef(new FileTreeSnapshotRequest<FileTreeNode[]>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const metadataControllersRef = useRef(new Map<string, AbortController>());

  const abortRequests = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    metadataControllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    metadataControllersRef.current.clear();
    inFlightRef.current.clear();
    metadataInFlightRef.current.clear();
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
    (targetPath: string | undefined, generation: FileTreeGeneration, offset = 0): Promise<void> => {
      const projectId = generation.projectId;
      const directoryKey = getRequestKey(targetPath);
      const requestKey = `${directoryKey}:${offset}`;
      const plan = createExplorerDirectoryRequestPlan(targetPath, offset);
      const isRoot = targetPath === undefined;

      const hydrateMetadata = () => {
        if (!isCurrentGeneration(generation)) return;
        const metadataKey = `metadata:${requestKey}`;
        const metadataPlan = createExplorerMetadataRequestPlan(targetPath, offset);
        const request = metadataInFlightRef.current.getOrCreate(metadataKey, generation, async () => {
          const controller = new AbortController();
          metadataControllersRef.current.set(metadataKey, controller);
          try {
            const response = await api.getFileTreePage(projectId, {
              ...metadataPlan,
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new Error(`Metadata fetch failed: ${response.status} ${await response.text()}`);
            }
            return { response, data: (await response.json()) as FileTreePageResponse };
          } finally {
            if (metadataControllersRef.current.get(metadataKey) === controller) {
              metadataControllersRef.current.delete(metadataKey);
            }
          }
        });

        void request.then(({ data }) => {
          if (data && isCurrentGeneration(generation)) {
            setFilesForGeneration(generation, (files) => reconcileFileTreeMetadata(files, data.items));
          }
        }).catch((error: unknown) => {
          if ((error as { name?: string }).name !== 'AbortError' && isCurrentGeneration(generation)) {
            console.error('Error hydrating file metadata:', error);
          }
        });
      };

      setDirectoryLoading((previous) => {
        if (previous.has(directoryKey)) {
          return previous;
        }
        const next = new Set(previous);
        next.add(directoryKey);
        return next;
      });

      const request = inFlightRef.current.getOrCreate(requestKey, generation, async () => {
        const controller = new AbortController();
        controllersRef.current.set(requestKey, controller);
        try {
          const response = await api.getFileTreePage(projectId, {
            ...plan,
            signal: controller.signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`File fetch failed: ${response.status} ${errorText}`);
          }

          return {
            response,
            data: (await response.json()) as FileTreePageResponse,
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
          if (offset > 0) {
            return appendDirectoryChildren(files, targetPath, data.items);
          }
          if (isRoot) {
            return replaceRootChildrenPreservingLoadedBranches(files, data.items);
          }

          // A directory may have been removed by a concurrent root refresh;
          // in that case the immutable helper safely leaves the root alone.
          return replaceDirectoryChildren(files, targetPath, data.items);
        });
        setPageState((previous) => {
          if (!isCurrentGeneration(generation)) return previous;
          const next = new Map(previous);
          next.set(directoryKey, { hasMore: data.hasMore, nextOffset: data.nextOffset, total: data.total });
          pageStateRef.current = next;
          recentPageStateCache.set(projectId, next);
          return next;
        });
        // Let the structural commit and loading-state clear reach a paint before
        // metadata work begins on the same page.
        setTimeout(hydrateMetadata, 0);
      }).catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError' && isCurrentGeneration(generation)) {
          console.error('Error fetching files:', error);
        }
      }).finally(() => {
        if (!isCurrentGeneration(generation)) {
          return;
        }
        setDirectoryLoading((previous) => {
          if (!previous.has(directoryKey)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(directoryKey);
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

  const loadNextPage = useCallback((path?: string): Promise<void> => {
    const generation = generationRef.current;
    const continuation = pageStateRef.current.get(getRequestKey(path));
    if (!generation || !continuation?.hasMore || continuation.nextOffset === null) {
      return Promise.resolve();
    }
    return requestDirectory(path, generation, continuation.nextOffset);
  }, [requestDirectory]);

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
    const resetPages = new Map<string, FileTreePageState>();
    pageStateRef.current = resetPages;
    setPageState(resetPages);
    setDirectoryLoading(new Set(plans.map((plan) => getRequestKey(plan.targetPath))));
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
        includeMetadata: false,
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
      pageStateRef.current = new Map();
      setPageState(new Map());
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
    const cachedPages = recentPageStateCache.get(projectId) ?? new Map();
    filesRef.current = hydratedFiles;
    setState({
      projectId,
      files: hydratedFiles,
      // A cached tree must remain visible while its root is revalidated.
      loading: !hasCachedTree,
    });
    setDirectoryLoading(new Set());
    pageStateRef.current = cachedPages;
    setPageState(cachedPages);

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
    pageState,
    loadDirectory,
    loadNextPage,
    loadCompleteTree,
    refreshFiles,
  };
}
