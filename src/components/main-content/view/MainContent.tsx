import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { MainContentProps } from '../types/types';
import type { AppTab } from '../../../types/app';
import { usePaletteOpsRegister } from '../../../contexts/paletteOps';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { authenticatedFetch } from '../../../utils/api';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import { loadFeatureNamespaces } from '../../../i18n/config.js';
import { markCloudCliLifecycle } from '../../../lib/performanceDiagnostics';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

const FileTree = lazy(() => import('../../file-tree/view/FileTree'));
const ChatInterface = lazy(() => import('../../chat/view/ChatInterface'));
const StandaloneShell = lazy(() => import('../../standalone-shell/view/StandaloneShell'));
const GitPanel = lazy(() => import('../../git-panel/view/GitPanel'));
const PluginTabContent = lazy(() => import('../../plugins/view/PluginTabContent'));
const BrowserUsePanel = lazy(() => import('../../browser-use/view/BrowserUsePanel'));
const EditorSidebar = lazy(() => import('../../code-editor/view/EditorSidebar'));
const DocsUiPanel = lazy(() => import('../../docs-ui/view/DocsUiPanel'));

function ConditionalPanelLoadingState() {
  return (
    <div className="flex h-full w-full items-center justify-center" role="status" aria-label="Loading">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
    </div>
  );
}

function FeatureNamespaceBoundary({ namespace, children }: { namespace: string; children: React.ReactNode }) {
  useTranslation(namespace);
  return children;
}

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onProjectSelect,
  onProjectsRefresh,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);
  const [tabGenerations, setTabGenerations] = useState<Partial<Record<AppTab, number>>>({});
  const [chatInvoked, setChatInvoked] = useState(() => activeTab === 'chat' || Boolean(selectedSession));

  const shouldShowBrowserTab = browserUseEnabled;

  useEffect(() => {
    if (!isLoading && selectedProject) markCloudCliLifecycle('surface-ready', activeTab);
  }, [activeTab, isLoading, selectedProject]);

  const handleSoftReload = useCallback(() => {
    setTabGenerations((generations) => ({
      ...generations,
      [activeTab]: (generations[activeTab] ?? 0) + 1,
    }));
  }, [activeTab]);

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  useEffect(() => {
    const namespaces: string[] = [];
    if (chatInvoked) namespaces.push('chat');
    if (editingFile) namespaces.push('codeEditor');
    if (namespaces.length > 0) void loadFeatureNamespaces(namespaces);
  }, [chatInvoked, editingFile]);

  useEffect(() => {
    if (activeTab === 'chat' || selectedSession) setChatInvoked(true);
  }, [activeTab, selectedSession]);

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  const loadBrowserUseSettings = useCallback(async (event?: Event) => {
    if (event instanceof CustomEvent && typeof event.detail?.enabled === 'boolean') {
      setBrowserUseEnabled(event.detail.enabled);
      return;
    }
    try {
      const response = await authenticatedFetch('/api/browser-use/settings');
      const data = await response.json();
      setBrowserUseEnabled(Boolean(response.ok && data?.success !== false && data?.data?.settings?.enabled));
    } catch {
      setBrowserUseEnabled(false);
    }
  }, []);

  useEffect(() => {
    void loadBrowserUseSettings();
    window.addEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
    return () => window.removeEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
  }, [loadBrowserUseSettings]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
    // Opens the editor side panel in place, keeping the current tab (e.g. chat).
    openFileInEditor: (filePath: string) => {
      resolvedFileOpen(filePath);
    },
  });

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onSoftReload={handleSoftReload}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          {chatInvoked && <div key={`chat-${tabGenerations.chat ?? 0}`} className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <Suspense fallback={<ConditionalPanelLoadingState />}>
              <FeatureNamespaceBoundary namespace="chat">
                <ErrorBoundary area="chat" name="Chat" resetKeys={[selectedSession?.id, selectedProject.projectId]}>
                  <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionProcessing={onSessionProcessing}
                onSessionIdle={onSessionIdle}
                processingSessions={processingSessions}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                  />
                </ErrorBoundary>
              </FeatureNamespaceBoundary>
            </Suspense>
          </div>}

          {activeTab === 'files' && (
            <div key={`files-${tabGenerations.files ?? 0}`} className="h-full overflow-hidden">
              <Suspense fallback={<ConditionalPanelLoadingState />}>
                <ErrorBoundary area="file_tree" name="File tree" resetKeys={[selectedProject.projectId]}><FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} /></ErrorBoundary>
              </Suspense>
            </div>
          )}

          {activeTab === 'shell' && (
            <div key={`shell-${tabGenerations.shell ?? 0}`} className="h-full w-full overflow-hidden">
              <Suspense fallback={<ConditionalPanelLoadingState />}>
                <ErrorBoundary area="shell" name="Shell" resetKeys={[selectedProject.projectId]} retryLabel="Reset shell"><StandaloneShell
                  project={selectedProject}
                  isPlainShell
                  showHeader={false}
                  isActive={activeTab === 'shell'}
                /></ErrorBoundary>
              </Suspense>
            </div>
          )}

          {activeTab === 'git' && (
            <div key={`git-${tabGenerations.git ?? 0}`} className="h-full overflow-hidden">
              <Suspense fallback={<ConditionalPanelLoadingState />}>
                <ErrorBoundary area="git" name="Git panel" resetKeys={[selectedProject.projectId]}><GitPanel
                  selectedProject={selectedProject}
                  isMobile={isMobile}
                  onFileOpen={handleFileOpen}
                  onProjectSelect={onProjectSelect}
                  onProjectsRefresh={onProjectsRefresh}
                /></ErrorBoundary>
              </Suspense>
            </div>
          )}

          {shouldShowBrowserTab && activeTab === 'browser' && (
            <div key={`browser-${tabGenerations.browser ?? 0}`} className="h-full overflow-hidden">
              <Suspense fallback={<ConditionalPanelLoadingState />}>
                <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
              </Suspense>
            </div>
          )}

          {activeTab === 'docs' && (
            <div key={`docs-${tabGenerations.docs ?? 0}`} className="h-full overflow-hidden">
              <Suspense fallback={<ConditionalPanelLoadingState />}>
                <DocsUiPanel />
              </Suspense>
            </div>
          )}

          {activeTab.startsWith('plugin:') && (
            <div key={`${activeTab}-${tabGenerations[activeTab] ?? 0}`} className="h-full overflow-hidden">
              <Suspense fallback={<ConditionalPanelLoadingState />}>
                <ErrorBoundary area="plugin" name="Plugin" resetKeys={[activeTab, selectedProject.projectId]}><PluginTabContent
                  pluginName={activeTab.replace('plugin:', '')}
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                /></ErrorBoundary>
              </Suspense>
            </div>
          )}
        </div>

        {editingFile && (
          <Suspense fallback={<ConditionalPanelLoadingState />}>
            <FeatureNamespaceBoundary namespace="codeEditor">
              <ErrorBoundary area="editor" name="Editor" resetKeys={[editingFile, selectedProject.projectId]}><EditorSidebar
              editingFile={editingFile}
              isMobile={isMobile}
              editorExpanded={editorExpanded}
              editorWidth={editorWidth}
              resizeHandleRef={resizeHandleRef}
              onResizeStart={handleResizeStart}
              onCloseEditor={handleCloseEditor}
              onToggleEditorExpand={handleToggleEditorExpand}
              projectPath={selectedProject.path}
              /></ErrorBoundary>
            </FeatureNamespaceBoundary>
          </Suspense>
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);
