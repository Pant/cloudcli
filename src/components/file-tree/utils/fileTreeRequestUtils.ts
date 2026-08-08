import type { FileTreeGeneration, FileTreeNode, FileTreeRequestOptions } from '../types/types';

import {
  createFileTreeGeneration,
  findLoadedDirectoryPaths,
  nextFileTreeGeneration,
} from './fileTreeUtils';

export type FileTreeRequestPlan = Pick<FileTreeRequestOptions, 'targetPath' | 'depth' | 'includeMetadata'>;

/** The explorer requests one metadata-rich directory page without traversing descendants. */
export function createExplorerDirectoryRequestPlan(targetPath?: string): FileTreeRequestPlan {
  return {
    ...(targetPath ? { targetPath } : {}),
    depth: 0,
    includeMetadata: true,
  };
}

/** Root is always refreshed before branches so a removed directory cannot retain stale children. */
export function planLoadedBranchRefresh(items: FileTreeNode[]): FileTreeRequestPlan[] {
  return [
    createExplorerDirectoryRequestPlan(),
    ...findLoadedDirectoryPaths(items).map((targetPath) => createExplorerDirectoryRequestPlan(targetPath)),
  ];
}

export function createExplorerRequestGeneration(projectId: string): FileTreeGeneration {
  return createFileTreeGeneration(projectId);
}

export function advanceExplorerRequestGeneration(
  generation: FileTreeGeneration,
  projectId: string,
): FileTreeGeneration {
  if (generation.projectId !== projectId) {
    return createExplorerRequestGeneration(projectId);
  }

  return nextFileTreeGeneration(generation);
}

export type FileTreeInitialState = {
  files: FileTreeNode[];
  hasCachedTree: boolean;
};

export function getCachedFileTreeInitialState(
  projectId: string | undefined,
  readCache: (projectId: string) => FileTreeNode[] | undefined,
): FileTreeInitialState {
  if (!projectId) {
    return { files: [], hasCachedTree: false };
  }

  const files = readCache(projectId);
  return {
    files: files ?? [],
    hasCachedTree: files !== undefined,
  };
}

/** Promise registry used by the hook to share a directory request among rapid clicks. */
export class FileTreeInFlightRequests<T> {
  private readonly requests = new Map<string, { generation: FileTreeGeneration; promise: Promise<T> }>();

  getOrCreate(
    key: string,
    generation: FileTreeGeneration,
    createRequest: () => Promise<T>,
  ): Promise<T> {
    const existing = this.requests.get(key);
    if (existing && existing.generation.projectId === generation.projectId
      && existing.generation.generation === generation.generation) {
      return existing.promise;
    }

    const promise = createRequest();
    this.requests.set(key, { generation, promise });
    void promise.then(
      () => this.removeIfCurrent(key, promise),
      () => this.removeIfCurrent(key, promise),
    );
    return promise;
  }

  clear(): void {
    this.requests.clear();
  }

  private removeIfCurrent(key: string, promise: Promise<T>): void {
    if (this.requests.get(key)?.promise === promise) {
      this.requests.delete(key);
    }
  }
}

/**
 * Coordinates the expensive complete-project snapshot used by search.  The
 * snapshot is scoped to a project generation: query edits reuse the same
 * successful result, while refreshes/project switches explicitly invalidate
 * it before starting a new request.
 */
export class FileTreeSnapshotRequest<T> {
  private snapshot: { generation: FileTreeGeneration; data: T } | undefined;

  private inFlight: { generation: FileTreeGeneration; promise: Promise<T> } | undefined;

  getSnapshot(generation: FileTreeGeneration): T | undefined {
    if (!this.snapshot || !sameGeneration(this.snapshot.generation, generation)) {
      return undefined;
    }

    return this.snapshot.data;
  }

  getOrCreate(
    generation: FileTreeGeneration,
    createRequest: () => Promise<T>,
  ): Promise<T> {
    const snapshot = this.getSnapshot(generation);
    if (snapshot !== undefined) {
      return Promise.resolve(snapshot);
    }

    if (this.inFlight && sameGeneration(this.inFlight.generation, generation)) {
      return this.inFlight.promise;
    }

    const promise = createRequest();
    this.inFlight = { generation, promise };
    void promise.then(
      (data) => {
        if (this.inFlight?.promise === promise) {
          this.snapshot = { generation, data };
          this.inFlight = undefined;
        }
      },
      () => {
        if (this.inFlight?.promise === promise) {
          this.inFlight = undefined;
        }
      },
    );
    return promise;
  }

  invalidate(): void {
    this.snapshot = undefined;
    this.inFlight = undefined;
  }
}

function sameGeneration(left: FileTreeGeneration, right: FileTreeGeneration): boolean {
  return left.projectId === right.projectId && left.generation === right.generation;
}
