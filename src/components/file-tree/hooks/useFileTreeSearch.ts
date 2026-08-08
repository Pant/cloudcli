import { useEffect, useRef, useState } from 'react';

import { collectExpandedDirectoryPaths, filterFileTree } from '../utils/fileTreeUtils';
import type { FileTreeGeneration, FileTreeNode } from '../types/types';

type UseFileTreeSearchArgs = {
  files: FileTreeNode[];
  expandDirectories: (paths: string[]) => void;
  generation: FileTreeGeneration | null;
  loadCompleteTree: () => Promise<FileTreeNode[]>;
  onSearchError?: (message: string) => void;
};

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredFiles: FileTreeNode[];
  loading: boolean;
};

export function useFileTreeSearch({
  files,
  expandDirectories,
  generation,
  loadCompleteTree,
  onSearchError,
}: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  const [searchQuery, setSearchQuery] = useState('');
  const [filteredFiles, setFilteredFiles] = useState<FileTreeNode[]>(files);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const query = searchQuery.trim().toLowerCase();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!query) {
      setFilteredFiles(files);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    void loadCompleteTree()
      .then((completeFiles) => {
        if (!active || requestIdRef.current !== requestId) {
          return;
        }

        const filtered = filterFileTree(completeFiles, query);
        setFilteredFiles(filtered);
        // Keep search results visible by opening every matching ancestor directory once per query update.
        expandDirectories(collectExpandedDirectoryPaths(filtered));
      })
      .catch((error: unknown) => {
        if (!active || requestIdRef.current !== requestId) {
          return;
        }

        // Keep the lazy tree visible if the authoritative request fails; never
        // turn unloaded directories into a false "no matches" result.
        setFilteredFiles(files);
        onSearchError?.((error as Error).message || 'Failed to search files');
      })
      .finally(() => {
        if (active && requestIdRef.current === requestId) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [files, searchQuery, expandDirectories, generation, loadCompleteTree, onSearchError]);

  return {
    searchQuery,
    setSearchQuery,
    filteredFiles,
    loading,
  };
}
