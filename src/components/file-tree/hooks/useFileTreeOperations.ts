import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import JSZip from 'jszip';

import { api } from '../../../utils/api';
import type { FileTreeBatchOperation, FileTreeNode } from '../types/types';
import type { Project } from '../../../types/app';
import { collectFileTreeZipEntries } from '../utils/fileTreeUtils';

// Invalid filename characters
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export type ToastMessage = {
  message: string;
  type: 'success' | 'error';
};

export type DeleteConfirmation = {
  isOpen: boolean;
  items: FileTreeNode[];
};

export type UseFileTreeOperationsOptions = {
  selectedProject: Project | null;
  onRefresh: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
};

export type UseFileTreeOperationsResult = {
  // Rename operations
  renamingItem: FileTreeNode | null;
  renameValue: string;
  handleStartRename: (item: FileTreeNode) => void;
  handleCancelRename: () => void;
  handleConfirmRename: () => Promise<void>;
  setRenameValue: (value: string) => void;

  // Delete operations
  deleteConfirmation: DeleteConfirmation;
  handleStartDelete: (item: FileTreeNode) => void;
  handleStartBatch: (operation: FileTreeBatchOperation, item?: FileTreeNode) => void;
  handleCancelDelete: () => void;
  handleConfirmDelete: () => Promise<void>;

  selectedPaths: Set<string>;
  batchOperation: FileTreeBatchOperation | null;
  batchDestination: string;
  setBatchDestination: (path: string) => void;
  toggleSelection: (item: FileTreeNode) => void;
  clearSelection: () => void;
  closeBatchDialog: () => void;
  handleConfirmBatch: () => Promise<void>;

  // Create operations
  isCreating: boolean;
  newItemParent: string;
  newItemType: 'file' | 'directory';
  newItemName: string;
  handleStartCreate: (parentPath: string, type: 'file' | 'directory') => void;
  handleCancelCreate: () => void;
  handleConfirmCreate: () => Promise<void>;
  setNewItemName: (name: string) => void;

  // Other operations
  handleCopyPath: (item: FileTreeNode) => void;
  handleDownload: (item: FileTreeNode) => Promise<void>;

  // Loading state
  operationLoading: boolean;

  // Validation
  validateFilename: (name: string) => string | null;
};

export function useFileTreeOperations({
  selectedProject,
  onRefresh,
  showToast,
}: UseFileTreeOperationsOptions): UseFileTreeOperationsResult {
  const { t } = useTranslation();

  // State
  const [renamingItem, setRenamingItem] = useState<FileTreeNode | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation>({
    isOpen: false,
    items: [],
  });
  const [isCreating, setIsCreating] = useState(false);
  const [newItemParent, setNewItemParent] = useState('');
  const [newItemType, setNewItemType] = useState<'file' | 'directory'>('file');
  const [newItemName, setNewItemName] = useState('');
  const [operationLoading, setOperationLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [batchOperation, setBatchOperation] = useState<FileTreeBatchOperation | null>(null);
  const [batchDestination, setBatchDestination] = useState('');

  useEffect(() => {
    setSelectedPaths(new Set());
    setBatchOperation(null);
    setBatchDestination('');
    setDeleteConfirmation({ isOpen: false, items: [] });
  }, [selectedProject?.projectId]);

  const toggleSelection = useCallback((item: FileTreeNode) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(item.path)) next.delete(item.path); else next.add(item.path);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedPaths(new Set()), []);
  const closeBatchDialog = useCallback(() => {
    setBatchOperation(null);
    setBatchDestination('');
  }, []);

  // Validation
  const validateFilename = useCallback((name: string): string | null => {
    if (!name || !name.trim()) {
      return t('fileTree.validation.emptyName', 'Filename cannot be empty');
    }
    if (INVALID_FILENAME_CHARS.test(name)) {
      return t('fileTree.validation.invalidChars', 'Filename contains invalid characters');
    }
    if (RESERVED_NAMES.test(name)) {
      return t('fileTree.validation.reserved', 'Filename is a reserved name');
    }
    if (/^\.+$/.test(name)) {
      return t('fileTree.validation.dotsOnly', 'Filename cannot be only dots');
    }
    return null;
  }, [t]);

  // Rename operations
  const handleStartRename = useCallback((item: FileTreeNode) => {
    setRenamingItem(item);
    setRenameValue(item.name);
    setIsCreating(false);
  }, []);

  const handleCancelRename = useCallback(() => {
    setRenamingItem(null);
    setRenameValue('');
  }, []);

  const handleConfirmRename = useCallback(async () => {
    if (!renamingItem || !selectedProject) return;

    const error = validateFilename(renameValue);
    if (error) {
      showToast(error, 'error');
      return;
    }

    if (renameValue === renamingItem.name) {
      handleCancelRename();
      return;
    }

    setOperationLoading(true);
    try {
      const response = await api.renameFile(selectedProject.projectId, {
        oldPath: renamingItem.path,
        newName: renameValue,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to rename');
      }

      showToast(t('fileTree.toast.renamed', 'Renamed successfully'), 'success');
      onRefresh();
      handleCancelRename();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [renamingItem, renameValue, selectedProject, validateFilename, showToast, t, onRefresh, handleCancelRename]);

  // Delete operations
  const handleStartDelete = useCallback((item: FileTreeNode) => {
    const items = selectedPaths.has(item.path) ? [...selectedPaths].map((path) => ({ path, name: path.split('/').pop() || path, type: 'file' as const })) : [item];
    setDeleteConfirmation({ isOpen: true, items });
  }, [selectedPaths]);

  const handleStartBatch = useCallback((operation: FileTreeBatchOperation, item?: FileTreeNode) => {
    if (item && !selectedPaths.has(item.path)) setSelectedPaths(new Set([item.path]));
    if (operation === 'delete') {
      const paths = item && !selectedPaths.has(item.path) ? [item.path] : [...selectedPaths];
      setDeleteConfirmation({ isOpen: true, items: paths.map((path) => ({ path, name: path.split('/').pop() || path, type: 'file' })) });
    } else setBatchOperation(operation);
  }, [selectedPaths]);

  const handleCancelDelete = useCallback(() => {
    setDeleteConfirmation({ isOpen: false, items: [] });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    const { items } = deleteConfirmation;
    if (items.length === 0 || !selectedProject) return;

    setOperationLoading(true);
    try {
      const response = await api.batchMutateFiles(selectedProject.projectId, { operation: 'delete', sources: items.map(({ path }) => path), destination: undefined });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete');
      }

      showToast(
        t('fileTree.toast.itemsDeleted', '{{count}} item(s) deleted', { count: items.length }),
        'success'
      );
      onRefresh();
      clearSelection();
      handleCancelDelete();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [deleteConfirmation, selectedProject, showToast, t, onRefresh, handleCancelDelete, clearSelection]);

  const handleConfirmBatch = useCallback(async () => {
    if (!selectedProject || !batchOperation || batchOperation === 'delete' || selectedPaths.size === 0) return;
    setOperationLoading(true);
    try {
      const response = await api.batchMutateFiles(selectedProject.projectId, {
        operation: batchOperation, sources: [...selectedPaths], destination: batchDestination,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `Failed to ${batchOperation}`);
      }
      showToast(t('fileTree.toast.batchComplete', '{{operation}} completed for {{count}} item(s)', { operation: batchOperation, count: selectedPaths.size }), 'success');
      onRefresh();
      clearSelection();
      closeBatchDialog();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [batchDestination, batchOperation, clearSelection, closeBatchDialog, onRefresh, selectedPaths, selectedProject, showToast, t]);

  // Create operations
  const handleStartCreate = useCallback((parentPath: string, type: 'file' | 'directory') => {
    setNewItemParent(parentPath || '');
    setNewItemType(type);
    setNewItemName(type === 'file' ? 'untitled.txt' : 'new-folder');
    setIsCreating(true);
    setRenamingItem(null);
  }, []);

  const handleCancelCreate = useCallback(() => {
    setIsCreating(false);
    setNewItemParent('');
    setNewItemName('');
  }, []);

  const handleConfirmCreate = useCallback(async () => {
    if (!selectedProject) return;

    const error = validateFilename(newItemName);
    if (error) {
      showToast(error, 'error');
      return;
    }

    setOperationLoading(true);
    try {
      const response = await api.createFile(selectedProject.projectId, {
        path: newItemParent,
        type: newItemType,
        name: newItemName,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create');
      }

      showToast(
        newItemType === 'file'
          ? t('fileTree.toast.fileCreated', 'File created successfully')
          : t('fileTree.toast.folderCreated', 'Folder created successfully'),
        'success'
      );
      onRefresh();
      handleCancelCreate();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [selectedProject, newItemParent, newItemType, newItemName, validateFilename, showToast, t, onRefresh, handleCancelCreate]);

  // Copy path to clipboard
  const handleCopyPath = useCallback((item: FileTreeNode) => {
    navigator.clipboard.writeText(item.path).catch(() => {
      // Clipboard API may fail in some contexts (e.g., non-HTTPS)
      showToast(t('fileTree.toast.copyFailed', 'Failed to copy path'), 'error');
      return;
    });
    showToast(t('fileTree.toast.pathCopied', 'Path copied to clipboard'), 'success');
  }, [showToast, t]);

  const triggerBrowserDownload = useCallback((blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = fileName;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, []);

  // Download a single file
  const downloadSingleFile = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject) return;

    // Use the binary streaming endpoint so downloads preserve raw bytes.
    const response = await api.readFileBlob(selectedProject.projectId, item.path);

    if (!response.ok) {
      throw new Error('Failed to download file');
    }

    const blob = await response.blob();
    triggerBrowserDownload(blob, item.name);
  }, [selectedProject, triggerBrowserDownload]);

  // Download folder as ZIP
  const downloadFolderAsZip = useCallback(async (folder: FileTreeNode) => {
    if (!selectedProject) return;

    const zip = new JSZip();

    // The UI node may only contain opened branches. Fetch the authoritative
    // subtree before building the ZIP manifest so unopened descendants are not
    // silently omitted.
    const response = await api.getFiles(selectedProject.projectId, {
      targetPath: folder.path,
      depth: 10,
      includeMetadata: false,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to load "${folder.name}" for ZIP export: ${response.status} ${errorText}`);
    }

    const subtreeChildren = (await response.json()) as FileTreeNode[];
    const entries = collectFileTreeZipEntries(subtreeChildren);
    for (const { node, archivePath } of entries) {
      const fileResponse = await api.readFileBlob(selectedProject.projectId, node.path);
      if (!fileResponse.ok) {
        throw new Error(`Failed to download "${node.name}" for ZIP export`);
      }

      // Store raw bytes in the archive so binary files stay intact.
      const fileBytes = await fileResponse.arrayBuffer();
      zip.file(archivePath, fileBytes);
    }

    // Generate ZIP file
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    triggerBrowserDownload(zipBlob, `${folder.name}.zip`);

    showToast(t('fileTree.toast.folderDownloaded', 'Folder downloaded as ZIP'), 'success');
  }, [selectedProject, showToast, t, triggerBrowserDownload]);

  // Download file or folder
  const handleDownload = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject) return;

    setOperationLoading(true);
    try {
      if (item.type === 'directory') {
        // Download folder as ZIP
        await downloadFolderAsZip(item);
      } else {
        // Download single file
        await downloadSingleFile(item);
      }
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [downloadFolderAsZip, downloadSingleFile, selectedProject, showToast]);

  return {
    // Rename operations
    renamingItem,
    renameValue,
    handleStartRename,
    handleCancelRename,
    handleConfirmRename,
    setRenameValue,

    // Delete operations
    deleteConfirmation,
    handleStartDelete,
    handleStartBatch,
    handleCancelDelete,
    handleConfirmDelete,
    selectedPaths,
    batchOperation,
    batchDestination,
    setBatchDestination,
    toggleSelection,
    clearSelection,
    closeBatchDialog,
    handleConfirmBatch,

    // Create operations
    isCreating,
    newItemParent,
    newItemType,
    newItemName,
    handleStartCreate,
    handleCancelCreate,
    handleConfirmCreate,
    setNewItemName,

    // Other operations
    handleCopyPath,
    handleDownload,

    // Loading state
    operationLoading,

    // Validation
    validateFilename,
  };
}
