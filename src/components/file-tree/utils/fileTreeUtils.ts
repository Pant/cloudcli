import type { TFunction } from 'i18next';

import { IMAGE_FILE_EXTENSIONS } from '../constants/constants';
import type { FileTreeDestination, FileTreeGeneration, FileTreeNode } from '../types/types';

export type FileTreeNodes = FileTreeNode[];

function isRootPath(path: string | undefined): boolean {
  return path === undefined || path === '' || path === '.' || path === './';
}

function mapNodesIfChanged(
  nodes: FileTreeNodes,
  replaceNode: (node: FileTreeNode) => FileTreeNode,
): FileTreeNodes {
  let changed = false;
  const result = nodes.map((node) => {
    const replacement = replaceNode(node);
    if (replacement !== node) {
      changed = true;
    }
    return replacement;
  });
  return changed ? result : nodes;
}

/** Find one node by its stable absolute path without changing the tree. */
export function findFileTreeNode(items: FileTreeNodes, targetPath: string): FileTreeNode | undefined {
  for (const item of items) {
    if (item.path === targetPath) {
      return item;
    }

    if (item.type === 'directory' && item.children) {
      const match = findFileTreeNode(item.children, targetPath);
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

/** Resolve currently loaded nodes for path-based selection without dropping stale paths from state. */
export function resolveFileTreeNodes(items: FileTreeNodes, paths: Iterable<string>): FileTreeNode[] {
  const wanted = new Set(paths);
  const resolved: FileTreeNode[] = [];
  const visit = (nodes: FileTreeNodes) => nodes.forEach((node) => {
    if (wanted.has(node.path)) resolved.push(node);
    if (node.children) visit(node.children);
  });
  visit(items);
  return resolved;
}

/** Collect every file and directory path from a complete tree. */
export function collectFileTreePaths(items: FileTreeNodes): string[] {
  const paths: string[] = [];
  const visit = (nodes: FileTreeNodes) => nodes.forEach((node) => {
    paths.push(node.path);
    if (node.children) visit(node.children);
  });
  visit(items);
  return paths;
}

/** Collapse nested selections to the highest selected path. */
export function normalizeSelectedPaths(paths: Iterable<string>): string[] {
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return unique.filter((path) => !unique.some((parent) => parent !== path && path.startsWith(`${parent.replace(/\/$/, '')}/`)));
}

/** Build root-inclusive destinations, excluding selected directories and their descendants. */
export function collectFileTreeDestinations(items: FileTreeNodes, selectedPaths: Iterable<string>): FileTreeDestination[] {
  const selected = normalizeSelectedPaths(selectedPaths);
  const destinations: FileTreeDestination[] = [{ path: '', label: '/', depth: 0 }];
  const visit = (nodes: FileTreeNodes, depth: number) => nodes.forEach((node) => {
    if (node.type !== 'directory') return;
    if (selected.some((path) => node.path === path || node.path.startsWith(`${path.replace(/\/$/, '')}/`))) return;
    destinations.push({ path: node.path, label: node.name, depth });
    if (node.children) visit(node.children, depth + 1);
  });
  visit(items, 1);
  return destinations;
}

/**
 * Replace the children of exactly one loaded directory.  A root replacement
 * is represented by an omitted/empty path and replaces the top-level array.
 * Missing targets return the original array, which makes failed refreshes
 * safe to ignore and preserves every existing object identity.
 */
export function replaceDirectoryChildren(
  items: FileTreeNodes,
  targetPath: string | undefined,
  children: FileTreeNodes,
): FileTreeNodes {
  if (isRootPath(targetPath)) {
    return children;
  }

  const replace = (nodes: FileTreeNodes): FileTreeNodes => mapNodesIfChanged(nodes, (node) => {
    if (node.path === targetPath) {
      if (node.type !== 'directory') {
        return node;
      }
      return { ...node, children };
    }

    if (node.type !== 'directory' || !node.children) {
      return node;
    }

    const replacedChildren = replace(node.children);
    if (replacedChildren === node.children) {
      return node;
    }

    return { ...node, children: replacedChildren };
  });

  const result = replace(items);
  return result;
}

/** Append a page by stable path while preserving existing order and branch identity. */
export function appendDirectoryChildren(
  items: FileTreeNodes,
  targetPath: string | undefined,
  children: FileTreeNodes,
): FileTreeNodes {
  const appendUnique = (existing: FileTreeNodes): FileTreeNodes => {
    const paths = new Set(existing.map((node) => node.path));
    const additions = children.filter((node) => !paths.has(node.path));
    return additions.length === 0 ? existing : [...existing, ...additions];
  };

  if (isRootPath(targetPath)) {
    return appendUnique(items);
  }
  if (targetPath === undefined) {
    return items;
  }

  const node = findFileTreeNode(items, targetPath);
  if (!node || node.type !== 'directory') {
    return items;
  }
  return replaceDirectoryChildren(items, targetPath, appendUnique(node.children ?? []));
}

/**
 * Reconcile a root listing without throwing away already loaded directory
 * children.  Root requests intentionally return unloaded directory nodes;
 * keeping matching loaded branches prevents background revalidation from
 * making an expanded tree briefly disappear.
 */
export function replaceRootChildrenPreservingLoadedBranches(
  existing: FileTreeNodes,
  replacement: FileTreeNodes,
): FileTreeNodes {
  const existingByPath = new Map(existing.map((node) => [node.path, node]));

  return replacement.map((node) => {
    const previous = existingByPath.get(node.path);
    if (node.type === 'directory' && previous?.type === 'directory' && previous.children !== undefined) {
      return { ...node, children: previous.children };
    }
    return node;
  });
}

/** Reconcile metadata by path without replacing structure, children, or ordering. */
export function reconcileFileTreeMetadata(
  items: FileTreeNodes,
  metadataItems: FileTreeNodes,
): FileTreeNodes {
  const metadataByPath = new Map(metadataItems.map((node) => [node.path, node]));
  const reconcile = (nodes: FileTreeNodes): FileTreeNodes => mapNodesIfChanged(nodes, (node) => {
    const metadata = metadataByPath.get(node.path);
    const children = node.children ? reconcile(node.children) : node.children;
    const metadataChanged = Boolean(metadata && (
      node.size !== metadata.size
      || node.modified !== metadata.modified
      || node.permissionsRwx !== metadata.permissionsRwx
    ));

    if (!metadataChanged && children === node.children) {
      return node;
    }

    return {
      ...node,
      ...(metadata ? {
        size: metadata.size,
        modified: metadata.modified,
        permissionsRwx: metadata.permissionsRwx,
      } : {}),
      ...(children === undefined ? {} : { children }),
    };
  });

  return reconcile(items);
}

/** Mark a directory as loaded while preserving the meaningful `[]` state. */
export function markDirectoryLoaded(
  items: FileTreeNodes,
  targetPath: string | undefined,
  children: FileTreeNodes = [],
): FileTreeNodes {
  return replaceDirectoryChildren(items, targetPath, children);
}

/** Return every directory whose children have been fetched, including empty ones. */
export function findLoadedDirectoryPaths(items: FileTreeNodes): string[] {
  const paths: string[] = [];

  const visit = (nodes: FileTreeNodes) => {
    nodes.forEach((node) => {
      if (node.type !== 'directory') {
        return;
      }

      if (node.children !== undefined) {
        paths.push(node.path);
        visit(node.children);
      }
    });
  };

  visit(items);
  return paths;
}

/** Extract a directory/file node by path; root extraction returns no single node. */
export function extractFileTreeSubtree(
  items: FileTreeNodes,
  targetPath: string,
): FileTreeNode | undefined {
  return findFileTreeNode(items, targetPath);
}

/** Replace one complete subtree while retaining identity for unrelated branches. */
export function replaceFileTreeSubtree(
  items: FileTreeNodes,
  targetPath: string,
  replacement: FileTreeNode,
): FileTreeNodes {
  const replace = (nodes: FileTreeNodes): FileTreeNodes => mapNodesIfChanged(nodes, (node) => {
    if (node.path === targetPath) {
      return replacement;
    }
    if (node.type !== 'directory' || !node.children) {
      return node;
    }

    const replacedChildren = replace(node.children);
    return replacedChildren === node.children ? node : { ...node, children: replacedChildren };
  });

  const result = replace(items);
  return result;
}

/**
 * A result may be merged only when both its project and generation still match
 * the active request state.  Comparing the pair rather than only a counter
 * prevents a late response from a previous project from being accepted.
 */
export function isFileTreeGenerationCurrent(
  current: FileTreeGeneration,
  result: FileTreeGeneration,
): boolean {
  return current.projectId === result.projectId && current.generation === result.generation;
}

export function isStaleFileTreeGeneration(
  current: FileTreeGeneration,
  result: FileTreeGeneration,
): boolean {
  return !isFileTreeGenerationCurrent(current, result);
}

export function createFileTreeGeneration(projectId: string, generation = 0): FileTreeGeneration {
  return { projectId, generation };
}

export function nextFileTreeGeneration(
  generation: FileTreeGeneration,
  projectId = generation.projectId,
): FileTreeGeneration {
  return { projectId, generation: generation.generation + 1 };
}

/** A small LRU cache used for successful project tree snapshots. */
export class RecentProjectFileTreeCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly maximumEntries: number) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError('maximumEntries must be a positive integer');
    }
  }

  get(projectId: string): T | undefined {
    const value = this.entries.get(projectId);
    if (value !== undefined) {
      this.entries.delete(projectId);
      this.entries.set(projectId, value);
    }
    return value;
  }

  set(projectId: string, value: T): void {
    this.entries.delete(projectId);
    this.entries.set(projectId, value);
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  has(projectId: string): boolean {
    return this.entries.has(projectId);
  }

  delete(projectId: string): boolean {
    return this.entries.delete(projectId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}

export function createRecentProjectFileTreeCache<T>(maximumEntries = 3): RecentProjectFileTreeCache<T> {
  return new RecentProjectFileTreeCache(maximumEntries);
}

export function filterFileTree(items: FileTreeNode[], query: string): FileTreeNode[] {
  return items.reduce<FileTreeNode[]>((filteredItems, item) => {
    const matchesName = item.name.toLowerCase().includes(query);
    const filteredChildren =
      item.type === 'directory' && item.children ? filterFileTree(item.children, query) : [];

    if (matchesName || filteredChildren.length > 0) {
      filteredItems.push({
        ...item,
        children: filteredChildren,
      });
    }

    return filteredItems;
  }, []);
}

// During search we auto-expand every directory present in the filtered subtree.
export function collectExpandedDirectoryPaths(items: FileTreeNode[]): string[] {
  const paths: string[] = [];

  const visit = (nodes: FileTreeNode[]) => {
    nodes.forEach((node) => {
      if (node.type === 'directory' && node.children && node.children.length > 0) {
        paths.push(node.path);
        visit(node.children);
      }
    });
  };

  visit(items);
  return paths;
}

export type FileTreeZipEntry = {
  node: FileTreeNode;
  archivePath: string;
};

/** Flatten a complete subtree into the manifest consumed by ZIP downloads. */
export function collectFileTreeZipEntries(
  items: FileTreeNode[],
  prefix = '',
): FileTreeZipEntry[] {
  const entries: FileTreeZipEntry[] = [];

  const visit = (nodes: FileTreeNode[], currentPrefix: string) => {
    nodes.forEach((node) => {
      const archivePath = currentPrefix ? `${currentPrefix}/${node.name}` : node.name;
      if (node.type === 'file') {
        entries.push({ node, archivePath });
        return;
      }

      if (node.children) {
        visit(node.children, archivePath);
      }
    });
  };

  visit(items, prefix);
  return entries;
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '-';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const base = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(base));

  return `${(bytes / Math.pow(base, index)).toFixed(1).replace(/\.0$/, '')} ${sizes[index]}`;
}

export function formatRelativeTime(date: string | undefined, t: TFunction): string {
  if (!date) {
    return '-';
  }

  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return t('fileTree.justNow');
  }

  if (diffInSeconds < 3600) {
    return t('fileTree.minAgo', { count: Math.floor(diffInSeconds / 60) });
  }

  if (diffInSeconds < 86400) {
    return t('fileTree.hoursAgo', { count: Math.floor(diffInSeconds / 3600) });
  }

  if (diffInSeconds < 2592000) {
    return t('fileTree.daysAgo', { count: Math.floor(diffInSeconds / 86400) });
  }

  return past.toLocaleDateString();
}

export function isImageFile(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  return Boolean(extension && IMAGE_FILE_EXTENSIONS.has(extension));
}
