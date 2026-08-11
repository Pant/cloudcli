import type { LucideIcon } from 'lucide-react';

export type FileTreeViewMode = 'simple' | 'compact' | 'detailed';

export type FileTreeItemType = 'file' | 'directory';

export interface FileTreeNode {
  name: string;
  type: FileTreeItemType;
  path: string;
  size?: number;
  modified?: string;
  permissionsRwx?: string;
  children?: FileTreeNode[];
  [key: string]: unknown;
}

/**
 * Optional controls for a File Tree listing request.  `targetPath` is relative
 * to the project root; an omitted path requests the project root itself.
 * `path` is accepted as a convenience alias for callers that already use the
 * API's query-parameter name.
 */
export interface FileTreeRequestOptions {
  targetPath?: string;
  path?: string;
  depth?: number;
  includeMetadata?: boolean;
  metadata?: boolean;
  respectGitignore?: boolean;
}

export type FileTreePageRequestOptions = Omit<FileTreeRequestOptions, 'depth'> & {
  offset?: number;
  limit?: number;
};

export type FileTreePageResponse = {
  items: FileTreeNode[];
  hasMore: boolean;
  nextOffset: number | null;
  total: number;
};

export type FileTreePageState = Pick<FileTreePageResponse, 'hasMore' | 'nextOffset' | 'total'>;

export type FileTreeGeneration = {
  projectId: string;
  generation: number;
};

export interface FileTreeImageSelection {
  name: string;
  path: string;
  projectPath?: string;
  // DB projectId; used by ImageViewer to build the raw content URL.
  projectId: string;
}

export interface FileIconData {
  icon: LucideIcon;
  color: string;
}

export type FileIconMap = Record<string, FileIconData>;
