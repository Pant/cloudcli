import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import { useAuth } from '../../auth/context/authContextContract';
import { getUserCacheNamespace } from '../../../stores/sessionMessageCache';
import { editorRecoveryStore, type EditorRecoveryRecord } from '../../../stores/editorRecoveryStore';
import type { CodeEditorFile } from '../types/types';
import { isBinaryFile } from '../utils/binaryFile';
import { getPreviewKind } from '../utils/previewableFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  const { user } = useAuth();
  const accountId = getUserCacheNamespace(user);
  const [content, setContent] = useState('');
  const [baseline, setBaseline] = useState('');
  const [recovery, setRecovery] = useState<EditorRecoveryRecord | null>(null);
  const [hasRecoveryConflict, setHasRecoveryConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  // Some binaries (images, PDFs, audio, video) can be rendered natively, so the
  // editor shows an inline preview instead of the generic binary placeholder.
  const previewKind = getPreviewKind(file.name);
  // `fileProjectId` is the DB primary key passed down from the editor sidebar;
  // the fallback to `projectPath` preserves older callers that didn't yet
  // propagate the identifier.
  const fileProjectId = file.projectId ?? projectPath;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;
  const savingRef = useRef(false);
  const reloadingRef = useRef(false);
  const isRecoverable = Boolean(accountId && fileProjectId && !previewKind && !isBinaryFile(fileName) && !file.diffInfo);
  const isDirty = content !== baseline;

  const acceptServerContent = useCallback(async (serverContent: string) => {
    if (!isRecoverable || !accountId || !fileProjectId) {
      setContent(serverContent);
      setBaseline(serverContent);
      setRecovery(null);
      setHasRecoveryConflict(false);
      return;
    }
    const stored = await editorRecoveryStore.get(accountId, fileProjectId, filePath);
    if (stored) {
      setRecovery(stored);
      setHasRecoveryConflict(stored.baseline !== serverContent);
    }
    setContent(serverContent);
    setBaseline(serverContent);
  }, [accountId, filePath, fileProjectId, isRecoverable]);

  const loadFileContent = useCallback(async (manualReload = false) => {
    try {
      if (manualReload) {
        if (reloadingRef.current || savingRef.current) return;
        reloadingRef.current = true;
        setReloading(true);
        setSaveSuccess(false);
        setSaveError(null);
      } else {
        setLoading(true);
        setIsBinary(false);
      }

      if (!manualReload) {
        // Natively previewable media (image/pdf/audio/video) is rendered by
        // CodeEditorMediaPreview, so there is nothing to read as text here.
        // Clear any buffer left over from a previously opened text file so a
        // stray save can't write stale content over the binary file.
        if (getPreviewKind(file.name)) {
          setContent('');
          return;
        }

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          setContent('');
          setIsBinary(true);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          setContent(fileDiffNewString);
          setBaseline(fileDiffNewString);
          return;
        }
      }

      if (!fileProjectId) {
        throw new Error('Missing project identifier');
      }

      const response = await api.readFile(fileProjectId, filePath);
      if (!response.ok) {
        throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      await acceptServerContent(data.content);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error loading file:', error);
      if (manualReload) {
        setSaveError(message);
      } else {
        setContent(`// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`);
      }
    } finally {
      if (manualReload) {
        reloadingRef.current = false;
        setReloading(false);
      } else {
        setLoading(false);
      }
    }
  }, [acceptServerContent, file.name, file.diffInfo, fileDiffNewString, fileDiffOldString, fileName, filePath, fileProjectId]);

  useEffect(() => {
    void loadFileContent();
  }, [loadFileContent]);

  useEffect(() => {
    if (!isRecoverable || !accountId || !fileProjectId || !isDirty) return;
    const timer = window.setTimeout(() => {
      void editorRecoveryStore.put({ accountId, projectId: fileProjectId, filePath, content, baseline, updatedAt: Date.now() });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [accountId, baseline, content, filePath, fileProjectId, isDirty, isRecoverable]);

  const handleReload = useCallback(async () => {
    await loadFileContent(true);
  }, [loadFileContent]);

  const handleSave = useCallback(async () => {
    // Preview-only and binary files have no editable text buffer; never write
    // them back (e.g. via Cmd/Ctrl+S) or we'd corrupt the file on disk.
    if (previewKind || isBinaryFile(fileName) || savingRef.current || reloadingRef.current) {
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setSaveError(null);

    try {
      if (!fileProjectId) {
        throw new Error('Missing project identifier');
      }

      const response = await api.saveFile(fileProjectId, filePath, content);

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Save failed: ${response.status}`);
        }

        const textError = await response.text();
        console.error('Non-JSON error response:', textError);
        throw new Error(`Save failed: ${response.status} ${response.statusText}`);
      }

      await response.json();

      setBaseline(content);
      setRecovery(null);
      setHasRecoveryConflict(false);
      if (accountId && fileProjectId) await editorRecoveryStore.delete(accountId, fileProjectId, filePath);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      setSaveError(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [accountId, content, filePath, fileProjectId, previewKind, fileName]);

  const restoreRecovery = useCallback(() => {
    if (!recovery) return;
    setContent(recovery.content);
  }, [recovery]);

  const discardRecovery = useCallback(async () => {
    if (accountId && fileProjectId) await editorRecoveryStore.delete(accountId, fileProjectId, filePath);
    setRecovery(null);
    setHasRecoveryConflict(false);
  }, [accountId, filePath, fileProjectId]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name]);

  return {
    content,
    setContent,
    loading,
    reloading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    previewKind,
    fileProjectId,
    baseline,
    isDirty,
    recovery,
    hasRecoveryConflict,
    restoreRecovery,
    discardRecovery,
    handleSave,
    handleReload,
    handleDownload,
  };
};
