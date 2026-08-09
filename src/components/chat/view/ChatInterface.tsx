import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useWebSocket } from '../../../contexts/useWebSocket';
import PermissionContext from '../../../contexts/PermissionContext';
import type { ChatInterfaceProps, Provider } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useOpenCodeAgentState } from '../hooks/useOpenCodeAgentState';
import { useSessionStoreContext } from '../../../stores/sessionStoreContext';
import { api } from '../../../utils/api';
import type { AppointmentTriggerRequest, PromptAppointment } from '../types/appointments';

import type { QuestionFormSubmitHandler } from './subcomponents/QuestionFormCard';
import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import CommandResultModal from './subcomponents/CommandResultModal';
import PromptAppointmentModal from './subcomponents/PromptAppointmentModal';
import { persistOpenCodePreferenceChange } from './agentPreferenceIntegration';
import { ChatStatusBanner } from './chatDegradedState';
import { getChatDataState } from './chatDegradedState.utils';

export type AgentPreferenceFeedback = 'model' | 'reasoning';

const notificationReplyIntentKey = 'cloudcli:notification-reply-intent';
const notificationReplyEvent = 'cloudcli:notification-reply';
const notificationReplyIntentMaxAge = 60_000;

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
}: ChatInterfaceProps) {
  const { subscribe, connectionEpoch, transportState } = useWebSocket();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStoreContext();
  const agentModelSyncKeyRef = useRef('');
  const preferenceOperationRef = useRef(0);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [agentPreferenceFeedback, setAgentPreferenceFeedback] = useState<AgentPreferenceFeedback | null>(null);
  const [appointmentModalOpen, setAppointmentModalOpen] = useState(false);
  const [appointments, setAppointments] = useState<PromptAppointment[]>([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(false);
  const [appointmentError, setAppointmentError] = useState<string | null>(null);
  const [appointmentSubmitting, setAppointmentSubmitting] = useState(false);
  const reviewAutoOpenedRef = useRef(new Set<string>());
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  const resetStreamingState = useCallback(() => undefined, []);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    opencodeModel,
    setOpenCodeModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    sessionModelLoading,
    hardRefreshProviderModels,
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    selectedAgent,
    agentOptions,
    agentsLoading,
    selectAgent,
    rememberAgentModel,
    getAgentModel,
    getAgentPreferences,
    updateAgentPreferences,
    refreshAgents,
  } = useOpenCodeAgentState(
    provider,
    selectedProject?.fullPath || selectedProject?.path,
    selectedSession?.id,
    selectedSession?.agent,
    selectedSession?.model,
  );

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    establishDraftSession,
    isLoadingSessionMessages,
     isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    connectionEpoch,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    establishDraftSession(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [establishDraftSession, onSessionEstablished, onNavigateToSession]);

  const {
    input,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    uploadingFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    scheduleAppointment,
    sendQuestionFormAnswer,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    patchQueuedDraftOptions,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    currentProviderAgent: selectedAgent,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  useEffect(() => {
    const activeSessionId = currentSessionId || selectedSession?.id;
    if (!activeSessionId) return undefined;

    const focusComposer = () => {
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    };
    const consumeStoredIntent = () => {
      try {
        const rawIntent = sessionStorage.getItem(notificationReplyIntentKey);
        if (!rawIntent) return;
        const intent = JSON.parse(rawIntent) as { sessionId?: unknown; createdAt?: unknown };
        if (intent.sessionId !== activeSessionId) return;
        sessionStorage.removeItem(notificationReplyIntentKey);
        if (typeof intent.createdAt === 'number' && Date.now() - intent.createdAt <= notificationReplyIntentMaxAge) {
          focusComposer();
        }
      } catch {
        // Malformed or unavailable storage must not interfere with chat mounting.
      }
    };
    const handleReplyIntent = (event: Event) => {
      const replyEvent = event as CustomEvent<{ sessionId?: string }>;
      if (replyEvent.detail?.sessionId !== activeSessionId) return;
      try {
        sessionStorage.removeItem(notificationReplyIntentKey);
      } catch {
        // The event still provides a usable fallback when storage is unavailable.
      }
      focusComposer();
    };

    consumeStoredIntent();
    window.addEventListener(notificationReplyEvent, handleReplyIntent);
    return () => window.removeEventListener(notificationReplyEvent, handleReplyIntent);
  }, [currentSessionId, selectedSession?.id, textareaRef]);

  const refreshAppointments = useCallback(async () => {
    const projectId = selectedProject?.projectId;
    if (!projectId) return;
    setAppointmentsLoading(true);
    try {
      const response = await api.listProjectAppointments(projectId);
      if (!response.ok) throw new Error(`Unable to load appointments (${response.status})`);
      const body = await response.json();
      const rows = Array.isArray(body?.data) ? body.data : [];
      setAppointments(rows);
      setAppointmentError(null);
      if (rows.some((row: PromptAppointment) => row.status === 'needs_review') && !reviewAutoOpenedRef.current.has(projectId)) {
        reviewAutoOpenedRef.current.add(projectId);
        setAppointmentModalOpen(true);
      }
    } catch (error) {
      setAppointmentError(error instanceof Error ? error.message : 'Unable to load appointments.');
    } finally {
      setAppointmentsLoading(false);
    }
  }, [selectedProject?.projectId]);

  useEffect(() => {
    void refreshAppointments();
  }, [refreshAppointments]);

  const handleCreateAppointment = useCallback(async (trigger: AppointmentTriggerRequest) => {
    setAppointmentSubmitting(true);
    setAppointmentError(null);
    try {
      await scheduleAppointment(trigger);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to schedule prompt.';
      setAppointmentError(message);
      throw error;
    } finally {
      setAppointmentSubmitting(false);
    }
  }, [scheduleAppointment]);

  const showAgentPreferenceFeedback = useCallback((kind: AgentPreferenceFeedback) => {
    setAgentPreferenceFeedback(kind);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setAgentPreferenceFeedback(null), 3000);
  }, []);

  useEffect(() => () => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
  }, []);

  const handleQuestionFormSubmit = useCallback<QuestionFormSubmitHandler>(
    async (submission) => sendQuestionFormAnswer(submission.message),
    [sendQuestionFormAnswer],
  );

  const handleRecoveryRequired = useCallback((sessionId: string) => {
    // The server keeps this socket subscribed while REST fills a replay gap.
    // Re-subscribing here makes an inactive session acknowledge the same
    // refresh requirement forever and creates a canonical-history fetch loop.
    void sessionStore.recoverSession(sessionId);
  }, [sessionStore]);

  useChatRealtimeHandlers({
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onRecoveryRequired: handleRecoveryRequired,
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  const resolveAgentModelOption = useCallback((agent: string) => {
    const preferredModel = getAgentModel(agent);
    if (!preferredModel) {
      return null;
    }
    const exactMatch = currentProviderModelOptions.find((option) => option.value === preferredModel);
    if (exactMatch) {
      return exactMatch.value;
    }
    const suffixMatches = currentProviderModelOptions.filter(
      (option) => option.value.endsWith(`/${preferredModel}`),
    );
    return suffixMatches.length === 1 ? suffixMatches[0].value : null;
  }, [currentProviderModelOptions, getAgentModel]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    if (provider === 'opencode' && selectedAgent) {
      const operation = ++preferenceOperationRef.current;
      try {
        const preference = await persistOpenCodePreferenceChange({
          agent: selectedAgent,
          patch: { model },
          updateAgentPreferences,
          persistSessionModel: (nextModel) => selectProviderModel(
            provider,
            nextModel,
            currentSessionId || selectedSession?.id || null,
          ),
          patchQueuedOptions: patchQueuedDraftOptions,
          isCurrent: () => preferenceOperationRef.current === operation,
        });
        if (preference) showAgentPreferenceFeedback('model');
      } catch (error) {
        console.error('Error changing the selected OpenCode agent model:', error);
      }
      return;
    }
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, patchQueuedDraftOptions, provider, selectProviderModel, selectedAgent, selectedSession?.id, showAgentPreferenceFeedback, updateAgentPreferences]);

  const handleSelectComposerEffort = useCallback(async (nextEffort: string) => {
    if (provider !== 'opencode' || !selectedAgent) {
      setStoredProviderEffort(provider, nextEffort);
      return;
    }
    const operation = ++preferenceOperationRef.current;
    try {
      const preference = await persistOpenCodePreferenceChange({
        agent: selectedAgent,
        patch: { reasoningEffort: nextEffort },
        updateAgentPreferences,
        patchQueuedOptions: patchQueuedDraftOptions,
        isCurrent: () => preferenceOperationRef.current === operation,
      });
      if (!preference) return;
      setStoredProviderEffort(provider, preference.reasoningEffort);
      showAgentPreferenceFeedback('reasoning');
    } catch (error) {
      console.error('Error changing the selected OpenCode agent reasoning:', error);
    }
  }, [patchQueuedDraftOptions, provider, selectedAgent, setStoredProviderEffort, showAgentPreferenceFeedback, updateAgentPreferences]);

  const handleSelectComposerAgent = useCallback((agent: string) => {
    preferenceOperationRef.current += 1;
    setAgentPreferenceFeedback(null);
    selectAgent(agent);
  }, [selectAgent]);

  useEffect(() => {
    if (provider !== 'opencode') {
      agentModelSyncKeyRef.current = '';
      return;
    }
    if (!selectedAgent || agentOptions.length === 0 || currentProviderModelOptions.length === 0) {
      return;
    }

    const workspacePath = selectedProject?.fullPath || selectedProject?.path || '';
    const syncKey = `${workspacePath}::${selectedAgent}`;
    if (agentModelSyncKeyRef.current === syncKey) {
      return;
    }
    agentModelSyncKeyRef.current = syncKey;

    const operation = ++preferenceOperationRef.current;
    const preference = getAgentPreferences(selectedAgent);
    const restoredModel = resolveAgentModelOption(selectedAgent) || preference.model;
    setStoredProviderEffort(provider, preference.reasoningEffort);
    patchQueuedDraftOptions({
      agent: selectedAgent,
      ...(restoredModel ? { model: restoredModel } : {}),
      effort: preference.reasoningEffort,
    });
    if (!restoredModel || restoredModel === currentProviderModel) return;
    void selectProviderModel(provider, restoredModel, currentSessionId || selectedSession?.id || null)
      .then(() => {
        if (preferenceOperationRef.current === operation) rememberAgentModel(selectedAgent, restoredModel);
      })
      .catch((error) => console.error('Error restoring the selected agent model:', error));
  }, [
    agentOptions.length,
    currentProviderModel,
    currentProviderModelOptions.length,
    currentSessionId,
    provider,
    getAgentPreferences,
    patchQueuedDraftOptions,
    rememberAgentModel,
    resolveAgentModelOption,
    selectedAgent,
    selectedProject?.fullPath,
    selectedProject?.path,
    selectedSession?.id,
    selectProviderModel,
    setStoredProviderEffort,
  ]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);
  const sessionSnapshot = currentSessionId ? sessionStore.getSessionSnapshot(currentSessionId) : null;
  const chatDataState = getChatDataState({ messageCount: chatMessages.length, loading: isLoadingSessionMessages, sessionStatus: sessionSnapshot?.status ?? 'idle', transportState });
  const retryCanonicalHistory = useCallback(() => {
    if (!currentSessionId) return;
    void sessionStore.recoverSession(currentSessionId);
  }, [currentSessionId, sessionStore]);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <ChatStatusBanner state={chatDataState} onRetry={currentSessionId ? retryCanonicalHistory : undefined} />
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
           visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          onSubmitQuestionForm={handleQuestionFormSubmit}
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          agent={selectedAgent}
          availableAgentOptions={agentOptions}
          agentsLoading={agentsLoading}
           onSelectAgent={handleSelectComposerAgent}
          onRefreshAgents={() => void refreshAgents()}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
           onSelectEffort={handleSelectComposerEffort}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          modelsLoading={providerModelsLoading || sessionModelLoading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
           onSubmit={handleSubmit}
           onShowAppointments={() => setAppointmentModalOpen(true)}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingFiles={uploadingFiles}
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
           isTextareaExpanded={isTextareaExpanded}
           preferenceFeedback={agentPreferenceFeedback
             ? t(`composer.preferenceFeedback.${agentPreferenceFeedback}`)
             : null}
        />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
      <PromptAppointmentModal
        open={appointmentModalOpen}
        onClose={() => setAppointmentModalOpen(false)}
        projectId={selectedProject.projectId}
        prompt={input}
        attachmentCount={attachedFiles.length}
        appointments={appointments}
        loading={appointmentsLoading}
        submitting={appointmentSubmitting}
        error={appointmentError}
        onCreate={handleCreateAppointment}
        onAppointmentsChange={refreshAppointments}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
