import { useTranslation } from 'react-i18next';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { ChatMessage, QuestionFormAnswers } from '../../types/types';
import type {
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from '../../../../types/app';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import { groupConsecutiveTools, isToolGroupItem } from '../../utils/toolGrouping';
import { splitQuestionFormSegments } from '../../utils/questionForms';
import { findSubsequentQuestionFormAnswers } from '../../utils/questionFormTranscript';

import type { QuestionFormSubmitHandler } from './QuestionFormCard';
import MessageComponent from './MessageComponent';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';
import ToolGroupContainer from './ToolGroupContainer';
import ChatExportMenu from './ChatExportMenu';
import {
  LARGE_TRANSCRIPT_THRESHOLD,
  calculateMeasuredWindow,
  compensateMeasuredGrowth,
  keyboardWindowTarget,
} from './transcriptWindow';

interface ChatMessagesPaneProps {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  opencodeModel: string;
  setOpenCodeModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  onSubmitQuestionForm: QuestionFormSubmitHandler;
}

function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  opencodeModel,
  setOpenCodeModel,
  providerModelCatalog,
  providerModelsLoading,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  onSubmitQuestionForm,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const groupedVisibleMessages = useMemo(
    () => groupConsecutiveTools(visibleMessages, Boolean(showThinking)),
    [visibleMessages, showThinking],
  );
  const isWindowed = groupedVisibleMessages.length > LARGE_TRANSCRIPT_THRESHOLD;
  const [windowRevision, setWindowRevision] = useState(0);
  const [keyboardTargetIndex, setKeyboardTargetIndex] = useState<number | null>(null);
  const measuredHeightsRef = useRef(new Map<number, number>());
  const observedRowsRef = useRef(new Map<number, { element: HTMLElement; observer: ResizeObserver }>());
  const searchTargetIndex = useMemo(() => {
    if (!isWindowed) return null;
    const session = selectedSession as Record<string, unknown> | null;
    const snippet = typeof session?.__searchTargetSnippet === 'string'
      ? session.__searchTargetSnippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim().slice(0, 80).toLowerCase()
      : '';
    const timestamp = typeof session?.__searchTargetTimestamp === 'string'
      ? new Date(session.__searchTargetTimestamp).getTime()
      : Number.NaN;
    let closestIndex: number | null = null;
    let closestDifference = Infinity;
    for (let index = 0; index < groupedVisibleMessages.length; index += 1) {
      const item = groupedVisibleMessages[index];
      const messages = isToolGroupItem(item) ? item.messages : [item];
      if (snippet.length >= 10 && messages.some((message) => String(message.content || '').toLowerCase().includes(snippet))) return index;
      if (!Number.isNaN(timestamp)) {
        for (const message of messages) {
          const difference = Math.abs(new Date(message.timestamp).getTime() - timestamp);
          if (difference < closestDifference) { closestDifference = difference; closestIndex = index; }
        }
      }
    }
    return closestIndex;
  }, [groupedVisibleMessages, isWindowed, selectedSession]);
  const viewport = scrollContainerRef.current;
  const revealTargetIndex = searchTargetIndex ?? keyboardTargetIndex;
  void windowRevision;
  const measuredWindow = calculateMeasuredWindow(
    groupedVisibleMessages.length,
    viewport?.scrollTop ?? 0,
    viewport?.clientHeight ?? 800,
    measuredHeightsRef.current,
    revealTargetIndex,
  );
  const windowedItems = isWindowed
    ? groupedVisibleMessages.slice(measuredWindow.start, measuredWindow.end)
    : groupedVisibleMessages;
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!isWindowed || !container) return;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; setWindowRevision((revision) => revision + 1); });
    };
    container.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(container);
    update();
    return () => { container.removeEventListener('scroll', update); observer?.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [isWindowed, scrollContainerRef]);
  useLayoutEffect(() => {
    if (!isWindowed || revealTargetIndex === null) return;
    const container = scrollContainerRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-window-index="${revealTargetIndex}"]`);
    target?.scrollIntoView({ block: 'center' });
  }, [isWindowed, revealTargetIndex, scrollContainerRef, windowRevision]);
  useEffect(() => () => {
    observedRowsRef.current.forEach(({ observer }) => observer.disconnect());
    observedRowsRef.current.clear();
  }, []);
  const observeRow = useCallback((index: number, element: HTMLElement | null) => {
    const previous = observedRowsRef.current.get(index);
    if (previous?.element === element) return;
    previous?.observer.disconnect();
    observedRowsRef.current.delete(index);
    if (!element || typeof ResizeObserver === 'undefined') return;
    const record = () => {
      const next = element.getBoundingClientRect().height;
      const old = measuredHeightsRef.current.get(index);
      if (next <= 0 || next === old) return;
      measuredHeightsRef.current.set(index, next);
      const container = scrollContainerRef.current;
      if (container) container.scrollTop = compensateMeasuredGrowth({
        rowIndex: index,
        windowStart: measuredWindow.start,
        previousHeight: old,
        nextHeight: next,
        scrollTop: container.scrollTop,
        followingBottom: container.scrollHeight - container.scrollTop - container.clientHeight < 50,
      });
      setWindowRevision((revision) => revision + 1);
    };
    const observer = new ResizeObserver(record);
    observer.observe(element);
    observedRowsRef.current.set(index, { element, observer });
    record();
  }, [measuredWindow.start, scrollContainerRef]);
  const visibleMessageIndexes = useMemo(() => {
    const indexes = new WeakMap<ChatMessage, number>();
    const start = Math.max(0, chatMessages.length - visibleMessages.length);
    visibleMessages.forEach((message, index) => indexes.set(message, start + index));
    return indexes;
  }, [chatMessages.length, visibleMessages]);
  const questionFormAnswers = useMemo(() => {
    const answers = new WeakMap<ChatMessage, ReadonlyMap<string, QuestionFormAnswers>>();
    visibleMessages.forEach((message) => {
      if (message.type !== 'assistant' || message.isToolUse || message.isStreaming) return;
      const messageIndex = visibleMessageIndexes.get(message) ?? -1;
      const forms = splitQuestionFormSegments(String(message.content || ''))
        .filter((segment) => segment.kind === 'form');
      if (forms.length === 0) return;
      const byForm = new Map<string, QuestionFormAnswers>();
      forms.forEach((segment) => {
        if (segment.kind !== 'form') return;
        const submitted = findSubsequentQuestionFormAnswers(segment.form, chatMessages, messageIndex);
        if (submitted) byForm.set(segment.form.id, submitted);
      });
      answers.set(message, byForm);
    });
    return answers;
  }, [chatMessages, visibleMessageIndexes, visibleMessages]);

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // `normalizedToChatMessages` rebuilds fresh ChatMessage objects on every store
  // update, so caching keys by object identity (or via a cross-render allocation
  // Set) minted a brand-new key for the *same* logical message on each prepend —
  // remounting the whole list, which disconnects the scroll-restore anchor and
  // reflows heights, jumping the viewport to the bottom. Deriving keys purely
  // from this render's ordered messages (intrinsic key, disambiguated by
  // occurrence index on collision) yields the same key for the same message
  // order, so React preserves existing DOM nodes and component state on prepend.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isToolGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      tabIndex={0}
      aria-label={t('session.messages.conversation', { defaultValue: 'Conversation' })}
      onKeyDown={(event) => {
        if (!isWindowed || event.target !== event.currentTarget) return;
        const current = keyboardTargetIndex ?? measuredWindow.start;
        const target = keyboardWindowTarget(current, event.key, groupedVisibleMessages.length);
        if (target === null) return;
        event.preventDefault();
        setKeyboardTargetIndex(target);
      }}
      className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}
    >
      {chatMessages.length > 0 && (
        <div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex justify-end sm:px-4">
          <div className="pointer-events-auto">
            <ChatExportMenu messages={chatMessages} sessionTitle={selectedSession?.title} />
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4" role={isWindowed ? 'list' : undefined}>
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
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
        />
      ) : (
        <>
          {/* The server transcript is complete; these controls only reveal rows
              already present in the local rendering window. */}
          {chatMessages.length > visibleMessageCount && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="ml-1 text-blue-600 underline hover:text-blue-700" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                onClick={loadAllMessages}
              >
                {t('session.messages.loadAll')}
              </button>
            </div>
          )}

          {(() => {
            let prevMessage: ChatMessage | null = null;

            return <>
              {isWindowed && <div aria-hidden="true" style={{ height: measuredWindow.before }} />}
              {windowedItems.map((item, windowIndex) => {
              const absoluteIndex = isWindowed ? measuredWindow.start + windowIndex : windowIndex;
              if (isToolGroupItem(item)) {
                const groupPrevMessage = prevMessage;
                prevMessage = item.messages[item.messages.length - 1] || prevMessage;

                return (
                  <div key={`window-tool-${getMessageKey(item.messages[0])}`} ref={(element) => observeRow(absoluteIndex, element)} data-window-index={absoluteIndex} role="listitem" aria-posinset={absoluteIndex + 1} aria-setsize={groupedVisibleMessages.length}>
                  <ToolGroupContainer
                    key={`tool-group-${getMessageKey(item.messages[0])}`}
                    group={item}
                    prevMessage={groupPrevMessage}
                    createDiff={createDiff}
                    getMessageKey={getMessageKey}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                    onSubmitQuestionForm={onSubmitQuestionForm}
                  />
                  </div>
                );
              }

              const messagePrevMessage = prevMessage;
              prevMessage = item;

              return (
                <div key={`window-${getMessageKey(item)}`} ref={(element) => observeRow(absoluteIndex, element)} data-window-index={absoluteIndex} role="listitem" aria-posinset={absoluteIndex + 1} aria-setsize={groupedVisibleMessages.length}>
                <MessageComponent
                  key={getMessageKey(item)}
                  message={item}
                  messageKey={getMessageKey(item)}
                  prevMessage={messagePrevMessage}
                  createDiff={createDiff}
                  onFileOpen={onFileOpen}
                  onShowSettings={onShowSettings}
                  onGrantToolPermission={onGrantToolPermission}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  selectedProject={selectedProject}
                  provider={provider}
                  questionFormAnswers={questionFormAnswers.get(item)}
                  onSubmitQuestionForm={onSubmitQuestionForm}
                />
                </div>
              );
            })}
              {isWindowed && <div aria-hidden="true" style={{ height: measuredWindow.after }} />}
            </>;
          })()}
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
