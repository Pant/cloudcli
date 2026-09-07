import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '../../../contexts/paletteOps';
import { useTheme } from '../../../contexts/useTheme';
import { useReloadSafety } from '../../../contexts/ReloadSafetyContext';
import { useCodeEditorDocument } from '../hooks/useCodeEditorDocument';
import { useCodeEditorSettings } from '../hooks/useCodeEditorSettings';
import { useEditorKeyboardShortcuts } from '../hooks/useEditorKeyboardShortcuts';
import type { CodeEditorFile } from '../types/types';
import {
  createScrollToFirstChunkExtension,
  createCapabilityRequest,
  loadLanguageExtensions,
  loadMergeCapability,
  loadMinimapExtension,
  type MergeCapability,
} from '../utils/editorExtensions';
import { getEditorStyles } from '../utils/editorStyles';
import { createEditorToolbarPanelExtension } from '../utils/editorToolbarPanel';

import CodeEditorFooter from './subcomponents/CodeEditorFooter';
import CodeEditorHeader from './subcomponents/CodeEditorHeader';
import CodeEditorLoadingState from './subcomponents/CodeEditorLoadingState';
import CodeEditorSurface from './subcomponents/CodeEditorSurface';
import CodeEditorBinaryFile from './subcomponents/CodeEditorBinaryFile';
import CodeEditorMediaPreview from './subcomponents/CodeEditorMediaPreview';

type CodeEditorProps = {
  file: CodeEditorFile;
  onClose: () => void;
  projectPath?: string;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
};

export default function CodeEditor({
  file,
  onClose,
  projectPath,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
}: CodeEditorProps) {
  const { t } = useTranslation('codeEditor');
  const paletteOps = usePaletteOps();
  const { setReloadBlocker, confirmReload } = useReloadSafety();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiff, setShowDiff] = useState(Boolean(file.diffInfo));
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const [languageExtensions, setLanguageExtensions] = useState<Extension[]>([]);
  const [mergeCapability, setMergeCapability] = useState<MergeCapability | null>(null);
  const [minimapExtension, setMinimapExtension] = useState<Extension[]>([]);
  const languageRequest = useRef(0);
  const diffCapabilityRequest = useRef(0);

  // The code editor follows the app-wide theme; it has no theme of its own.
  const { isDarkMode } = useTheme();

  const {
    wordWrap,
    setWordWrap,
    minimapEnabled,
    showLineNumbers,
    fontSize,
  } = useCodeEditorSettings();

  const {
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
    handleSave,
    handleReload,
    handleDownload,
    isDirty,
    recovery,
    hasRecoveryConflict,
    restoreRecovery,
    discardRecovery,
  } = useCodeEditorDocument({
    file,
    projectPath,
  });

  const blockerId = useMemo(() => `editor:${fileProjectId ?? 'unknown'}:${file.path}`, [file.path, fileProjectId]);
  useEffect(() => {
    setReloadBlocker(blockerId, isDirty);
    return () => setReloadBlocker(blockerId, false);
  }, [blockerId, isDirty, setReloadBlocker]);

  const guardedClose = useCallback(() => {
    if (confirmReload('Close this file and keep its recovery copy for later?')) onClose();
  }, [confirmReload, onClose]);
  const guardedReload = useCallback(() => {
    if (!isDirty || confirmReload('Reload from the server? Your recovery copy will be retained.')) void handleReload();
  }, [confirmReload, handleReload, isDirty]);

  const isMarkdownFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'md' || extension === 'markdown';
  }, [file.name]);

  const isHtmlPreviewFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'html' || extension === 'htm';
  }, [file.name]);

  const openHtmlPreview = useCallback(() => {
    const previewWindow = window.open('', '_blank');
    if (!previewWindow) return;

    previewWindow.opener = null;
    previewWindow.document.title = file.name;
    previewWindow.document.body.style.margin = '0';

    const iframe = previewWindow.document.createElement('iframe');
    iframe.title = file.name;
    iframe.sandbox.add('allow-forms', 'allow-modals', 'allow-popups', 'allow-scripts');
    iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:white';

    iframe.srcdoc = content;

    previewWindow.document.body.appendChild(iframe);
  }, [content, file.name]);

  useEffect(() => {
    const request = createCapabilityRequest(languageRequest);
    void loadLanguageExtensions(file.name).then((language) => {
      if (request.isCurrent()) setLanguageExtensions(language);
    });
  }, [file.name]);

  useEffect(() => {
    const request = createCapabilityRequest(diffCapabilityRequest);
    const needsMerge = Boolean(file.diffInfo && showDiff && file.diffInfo.old_string !== undefined);
    if (!needsMerge) {
      setMergeCapability(null);
      setMinimapExtension([]);
      return;
    }

    void loadMergeCapability().then(async (merge) => {
      if (!request.isCurrent()) return;
      setMergeCapability(merge);

      const minimap = await loadMinimapExtension(
        { file, showDiff, minimapEnabled, isDarkMode },
        merge.getChunks,
      );
      if (request.isCurrent()) setMinimapExtension(minimap);
    });
  }, [file, isDarkMode, minimapEnabled, showDiff]);

  const scrollToFirstChunkExtension = useMemo(
    () => mergeCapability
      ? createScrollToFirstChunkExtension({ file, showDiff }, mergeCapability.getChunks)
      : [],
    [file, mergeCapability, showDiff],
  );

  const toolbarPanelExtension = useMemo(
    () => (
      createEditorToolbarPanelExtension({
        file,
        showDiff,
        isSidebar,
        isExpanded,
        onToggleDiff: () => setShowDiff((previous) => !previous),
        onPopOut,
        onToggleExpand,
        labels: {
          changes: t('toolbar.changes'),
          previousChange: t('toolbar.previousChange'),
          nextChange: t('toolbar.nextChange'),
          hideDiff: t('toolbar.hideDiff'),
          showDiff: t('toolbar.showDiff'),
          collapse: t('toolbar.collapse'),
          expand: t('toolbar.expand'),
        },
        getChunks: mergeCapability?.getChunks,
      })
    ),
    [file, isExpanded, isSidebar, mergeCapability, onPopOut, onToggleExpand, showDiff, t],
  );

  const extensions = useMemo(() => {
    const allExtensions: Extension[] = [
      ...languageExtensions,
      ...toolbarPanelExtension,
    ];

    if (file.diffInfo && showDiff && file.diffInfo.old_string !== undefined && mergeCapability) {
      allExtensions.push(
        mergeCapability.createExtension(file.diffInfo.old_string),
      );
      allExtensions.push(...minimapExtension);
      allExtensions.push(...scrollToFirstChunkExtension);
    }

    if (wordWrap) {
      allExtensions.push(EditorView.lineWrapping);
    }

    return allExtensions;
  }, [
    file.diffInfo,
    languageExtensions,
    mergeCapability,
    minimapExtension,
    scrollToFirstChunkExtension,
    showDiff,
    toolbarPanelExtension,
    wordWrap,
  ]);

  useEditorKeyboardShortcuts({
    onSave: handleSave,
    onClose: guardedClose,
    dependency: content,
  });

  if (loading) {
    return (
      <CodeEditorLoadingState
        isDarkMode={isDarkMode}
        isSidebar={isSidebar}
        loadingText={t('loading', { fileName: file.name })}
      />
    );
  }

  // Natively previewable media (image/pdf/audio/video) is rendered inline
  // instead of showing the generic "cannot be displayed" placeholder.
  if (previewKind) {
    return (
      <CodeEditorMediaPreview
        file={file}
        kind={previewKind}
        projectId={fileProjectId}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
         onClose={guardedClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        labels={{
          loading: t('filePreview.loading', 'Loading preview...'),
          error: t('filePreview.error', 'Unable to display this file.'),
          openInNewTab: t('filePreview.openInNewTab', 'Open in new tab'),
          fullscreen: t('actions.fullscreen', 'Fullscreen'),
          exitFullscreen: t('actions.exitFullscreen', 'Exit fullscreen'),
          close: t('actions.close', 'Close'),
        }}
      />
    );
  }

  // Binary file display
  if (isBinary) {
    return (
      <CodeEditorBinaryFile
        file={file}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
         onClose={guardedClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        title={t('binaryFile.title', 'Binary File')}
        message={t('binaryFile.message', 'The file "{{fileName}}" cannot be displayed in the text editor because it is a binary file.', { fileName: file.name })}
      />
    );
  }

  const outerContainerClassName = isSidebar
    ? 'w-full h-full flex flex-col'
    : `fixed inset-0 z-[9999] md:bg-black/50 md:flex md:items-center md:justify-center md:p-4 ${isFullscreen ? 'md:p-0' : ''}`;

  const innerContainerClassName = isSidebar
    ? 'bg-background flex flex-col w-full h-full'
    : `bg-background shadow-2xl flex flex-col w-full h-full md:rounded-lg md:shadow-2xl${
      isFullscreen ? ' md:w-full md:h-full md:rounded-none' : ' md:w-full md:max-w-6xl md:h-[80vh] md:max-h-[80vh]'
    }`;

  return (
    <>
      <style>{getEditorStyles(isDarkMode)}</style>
      <div className={outerContainerClassName}>
        <div className={innerContainerClassName}>
          <CodeEditorHeader
            file={file}
            isSidebar={isSidebar}
            isFullscreen={isFullscreen}
            isMarkdownFile={isMarkdownFile}
            isHtmlPreviewFile={isHtmlPreviewFile}
            markdownPreview={markdownPreview}
            wordWrap={wordWrap}
            saving={saving}
            reloading={reloading}
            saveSuccess={saveSuccess}
            onToggleMarkdownPreview={() => setMarkdownPreview((previous) => !previous)}
            onToggleWordWrap={() => setWordWrap((previous) => !previous)}
            onOpenHtmlPreview={openHtmlPreview}
            onOpenSettings={() => paletteOps.openSettings('appearance')}
            onDownload={handleDownload}
            onSave={handleSave}
             onReload={guardedReload}
            onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
             onClose={guardedClose}
            labels={{
              showingChanges: t('header.showingChanges'),
              editMarkdown: t('actions.editMarkdown'),
              previewMarkdown: t('actions.previewMarkdown'),
              previewHtml: t('actions.previewHtml', 'Open HTML preview in new tab'),
              enableWordWrap: t('actions.enableWordWrap'),
              disableWordWrap: t('actions.disableWordWrap'),
              settings: t('toolbar.settings'),
              download: t('actions.download'),
              save: t('actions.save'),
              saving: t('actions.saving'),
              reload: t('actions.reload'),
              reloading: t('actions.reloading'),
              saved: t('actions.saved'),
              fullscreen: t('actions.fullscreen'),
              exitFullscreen: t('actions.exitFullscreen'),
              close: t('actions.close'),
            }}
          />

          {saveError && (
            <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              {saveError}
            </div>
          )}
          {recovery && (
            <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
              <span>{hasRecoveryConflict ? 'Recovered edits were based on an older server version.' : 'Recovered unsaved edits are available.'}</span>
              <button type="button" className="underline" onClick={restoreRecovery}>Restore</button>
              <button type="button" className="underline" onClick={() => void discardRecovery()}>Discard</button>
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            <CodeEditorSurface
              content={content}
              onChange={setContent}
              markdownPreview={markdownPreview}
              isMarkdownFile={isMarkdownFile}
              isDarkMode={isDarkMode}
              fontSize={fontSize}
              showLineNumbers={showLineNumbers}
              extensions={extensions}
            />
          </div>

          <CodeEditorFooter
            content={content}
            linesLabel={t('footer.lines')}
            charactersLabel={t('footer.characters')}
            shortcutsLabel={t('footer.shortcuts')}
          />
        </div>
      </div>
    </>
  );
}
