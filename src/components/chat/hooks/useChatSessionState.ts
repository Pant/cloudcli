import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { NormalizedMessage } from '../../../stores/normalizedMessage';
import type { SessionStore } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';
import { stabilizeTokenUsageSnapshot } from '../utils/tokenUsageSnapshot';
import { reconcileLocalHistoryVisibility, revealAllLocalHistory, revealLocalHistoryWindow } from '../../../stores/sessionHistoryPolicy';

import { normalizedToChatMessages, stabilizeRenderedMessages } from './useChatMessages';
import {
  createExternalSessionRefreshOwner,
  createSessionMessageLoadingOwner,
  shouldBlockSessionMessageDisplay,
} from './sessionMessageLoading';
import {
  advanceViewportSettle,
  chooseViewportSnapshot,
  isSelectionCurrent,
  getViewportRevisionAction,
  shouldCancelViewportSettle,
  transitionViewportOwnership,
  type SavedViewport,
} from './sessionViewport';
import {
  createSessionIdentity,
  resolveCommittedSessionIdentity,
  stabilizeSessionIdentity,
  shouldAdoptCanonicalSelection,
  type CommittedSessionIdentity,
} from './sessionSelection';

const INITIAL_VISIBLE_MESSAGES = 100;
const LOCAL_REVEAL_CHUNK = 100;
const EMPTY_NORMALIZED_MESSAGES: NormalizedMessage[] = [];
export const MAX_SAVED_CHAT_VIEWPORTS = 20;

export function saveBoundedViewport(
  viewports: Map<string, SavedViewport>, key: string, viewport: SavedViewport, activeKey: string | null,
): void {
  viewports.delete(key);
  viewports.set(key, viewport);
  while (viewports.size > MAX_SAVED_CHAT_VIEWPORTS) {
    const oldest = viewports.keys().next().value as string | undefined;
    if (!oldest) break;
    if (oldest === activeKey) { const value = viewports.get(oldest)!; viewports.delete(oldest); viewports.set(oldest, value); continue; }
    viewports.delete(oldest);
  }
}

interface UseChatSessionStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  connectionEpoch: number;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: 'interactive_prompt', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its files immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
    files: Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
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
}: UseChatSessionStateArgs) {
  const [draftIdentity, setDraftIdentity] = useState<CommittedSessionIdentity | null>(null);
  const selectedSessionId = selectedSession?.id ?? null;
  const selectedProjectId = selectedProject?.projectId ?? null;
  const selectedIdentity = useMemo(() => selectedSessionId && selectedProjectId
    ? createSessionIdentity('selected', selectedSessionId, selectedProjectId)
    : null, [selectedProjectId, selectedSessionId]);
  const previousCommittedIdentityRef = useRef<CommittedSessionIdentity | null>(null);
  const committedIdentity = useMemo(() => {
    const resolved = resolveCommittedSessionIdentity({
      selectedSessionId,
      projectId: selectedProjectId,
      draft: draftIdentity,
    });
    const stable = stabilizeSessionIdentity(previousCommittedIdentityRef.current, resolved);
    previousCommittedIdentityRef.current = stable;
    return stable;
  }, [draftIdentity, selectedProjectId, selectedSessionId]);
  const currentSessionId = committedIdentity?.sessionId ?? null;
  const establishDraftSession = useCallback((sessionId: string) => {
    if (!selectedProject?.projectId) return;
    setDraftIdentity(createSessionIdentity('draft', sessionId, selectedProject.projectId));
  }, [selectedProject?.projectId]);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const sessionMessageLoadingOwnerRef = useRef(createSessionMessageLoadingOwner());
  const externalSessionRefreshOwnerRef = useRef(createExternalSessionRefreshOwner());
  const {
    getSubscriptionTarget,
    has: hasSession,
    isStale,
    getSessionSnapshot,
    warmSession,
    refreshFromServer,
  } = sessionStore;
  externalSessionRefreshOwnerRef.current.select(committedIdentity?.key ?? null, externalMessageUpdate ?? 0);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudgetState] = useState<Record<string, unknown> | null>(null);
  const tokenBudgetRef = useRef<Record<string, unknown> | null>(null);
  const tokenBudgetSessionRef = useRef<string | null>(selectedSession?.id || null);
  const setTokenBudget = useCallback((incoming: Record<string, unknown> | null) => {
    if (incoming === null) {
      tokenBudgetRef.current = null;
      setTokenBudgetState(null);
      return;
    }

    const stabilized = stabilizeTokenUsageSnapshot(tokenBudgetRef.current, incoming);
    tokenBudgetRef.current = stabilized;
    setTokenBudgetState(stabilized);
  }, []);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);
  const [viewStateIdentityKey, setViewStateIdentityKey] = useState<string | null>(committedIdentity?.key ?? null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<SavedViewport | null>(null);
  const pendingRevealAllTopRef = useRef<string | null>(null);
  const revealAllIdentityKeyRef = useRef<string | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const visibleMessageCountRef = useRef(INITIAL_VISIBLE_MESSAGES);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  const selectionKeyRef = useRef<string | null>(null);
  const savedViewportsRef = useRef(new Map<string, SavedViewport>());
  const currentViewportRef = useRef<SavedViewport | null>(null);
  const settleCleanupRef = useRef<(() => void) | null>(null);
  const applyingAutomaticScrollRef = useRef(false);
  const viewportCaptureFrameRef = useRef(0);
  const searchTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const captureViewport = useCallback((): SavedViewport | null => {
    const container = scrollContainerRef.current;
    if (!container) return null;
    const containerTop = container.getBoundingClientRect().top;
    let anchor: { key: string; offset: number } | null = null;
    for (const row of container.querySelectorAll<HTMLElement>('[data-message-key]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > containerTop + 1) {
        if (row.dataset.messageKey) anchor = { key: row.dataset.messageKey, offset: rect.top - containerTop };
        break;
      }
    }
    return chooseViewportSnapshot(container, anchor);
  }, []);
  const cancelViewportSettle = useCallback(() => {
    settleCleanupRef.current?.();
    settleCleanupRef.current = null;
  }, []);
  const startViewportSettle = useCallback((saved: SavedViewport, selectionKey: string) => {
    cancelViewportSettle();
    if (searchScrollActiveRef.current || !isSelectionCurrent(selectionKey, selectionKeyRef.current)) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    let rafId = 0;
    let observer: ResizeObserver | null = null;
    let settleState = { frame: 0, stableFrames: 0, lastMeasurement: null as number | null };
    let stopped = false;
    const apply = () => {
      if (stopped || searchScrollActiveRef.current || !isSelectionCurrent(selectionKey, selectionKeyRef.current)) return;
      if (saved.mode === 'bottom') {
        applyingAutomaticScrollRef.current = true;
        container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight - saved.bottomDistance);
      } else {
        const row = [...container.querySelectorAll<HTMLElement>('[data-message-key]')]
          .find((candidate) => candidate.dataset.messageKey === saved.key);
        if (row) {
          applyingAutomaticScrollRef.current = true;
          container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - saved.offset;
        }
      }
      queueMicrotask(() => { applyingAutomaticScrollRef.current = false; });
      const measurement = saved.mode === 'bottom'
        ? container.scrollHeight
        : Math.round((container.querySelector<HTMLElement>(`[data-message-key="${saved.key.replace(/["\\]/g, '\\$&')}"]`)?.getBoundingClientRect().top ?? 0) * 10);
      const advanced = advanceViewportSettle(settleState, measurement);
      settleState = advanced.state;
      if (advanced.done) {
        stopped = true;
        observer?.disconnect();
        currentViewportRef.current = captureViewport();
        return;
      }
      rafId = requestAnimationFrame(apply);
    };
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (!rafId && !stopped) rafId = requestAnimationFrame(apply);
      });
      observer.observe(container);
    }
    rafId = requestAnimationFrame(apply);
    settleCleanupRef.current = () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      observer?.disconnect();
    };
  }, [cancelViewportSettle, captureViewport]);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> AppContent -> MainContent -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
    */
    resetStreamingState();
    sessionMessageLoadingOwnerRef.current.invalidate();
    setIsLoadingSessionMessages(false);
    tokenBudgetSessionRef.current = null;
    setDraftIdentity(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);

    setTokenBudget(null);
    visibleMessageCountRef.current = INITIAL_VISIBLE_MESSAGES;
    revealAllIdentityKeyRef.current = null;
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setViewHiddenCount(0);
    setSearchTarget(null);
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    pendingInitialScrollRef.current = true;
    lastLoadedSessionKeyRef.current = null;
  }, [newSessionTrigger, onSessionIdle, resetStreamingState, setTokenBudget]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = committedIdentity?.sessionId ?? null;
  const activeIdentityKey = committedIdentity?.key ?? null;
  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const renderedMessagesRef = useRef<ChatMessage[]>([]);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Tell the store which session we're viewing so it only re-renders for this one
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionId !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionId;
    sessionStore.setActiveSession(activeSessionId);
  }

  useEffect(() => {
    if (shouldAdoptCanonicalSelection(draftIdentity, selectedIdentity)) setDraftIdentity(null);
  }, [draftIdentity, selectedIdentity]);

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  // `useSessionStore` keeps its slots in refs and uses an internal state tick
  // to notify consumers. Read on every render so that tick exposes the newly
  // fetched array; memoizing only by session/store identity freezes the first
  // (usually empty) snapshot for the lifetime of the selected session.
  const storeMessages = activeSessionId
    ? sessionStore.getMessages(activeSessionId)
    : EMPTY_NORMALIZED_MESSAGES;
  const activeSessionSnapshot = activeSessionId
    ? sessionStore.getSessionSnapshot(activeSessionId)
    : null;

  useEffect(() => {
    if (!activeSessionSnapshot?.hasDisplayableMessages || !isLoadingSessionMessages) return;
    setIsLoadingSessionMessages(false);
  }, [activeSessionSnapshot?.hasDisplayableMessages, isLoadingSessionMessages]);

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  const chatMessages = useMemo(() => {
    const all = stabilizeRenderedMessages(renderedMessagesRef.current, normalizedToChatMessages(storeMessages));
    renderedMessagesRef.current = all;
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [storeMessages, viewHiddenCount, pendingUserMessage]);

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    cancelViewportSettle();
    currentViewportRef.current = { mode: 'bottom', bottomDistance: 0 };
    setIsUserScrolledUp(false);
    scrollToBottom();
    if (allMessagesLoaded) {
      revealAllIdentityKeyRef.current = null;
      visibleMessageCountRef.current = INITIAL_VISIBLE_MESSAGES;
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      const hasAllLocalRows = chatMessages.length <= INITIAL_VISIBLE_MESSAGES;
      setAllMessagesLoaded(hasAllLocalRows);
      allMessagesLoadedRef.current = hasAllLocalRows;
    }
    const selectionKey = selectionKeyRef.current;
    if (selectionKey) startViewportSettle({ mode: 'bottom', bottomDistance: 0 }, selectionKey);
  }, [allMessagesLoaded, cancelViewportSettle, chatMessages.length, scrollToBottom, startViewportSettle]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const revealLocalMessages = useCallback((chunkSize: number) => {
    if (allMessagesLoadedRef.current) return false;

    const total = Math.max(totalMessages, chatMessages.length);
    const currentVisibleCount = visibleMessageCountRef.current;
    const next = revealLocalHistoryWindow(currentVisibleCount, total, chunkSize);
    if (next.visibleCount === currentVisibleCount) {
      allMessagesLoadedRef.current = next.allMessagesLoaded;
      setAllMessagesLoaded(next.allMessagesLoaded);
      return false;
    }

    const container = scrollContainerRef.current;
    if (container) {
      pendingScrollRestoreRef.current = captureViewport();
    }
    visibleMessageCountRef.current = next.visibleCount;
    setVisibleMessageCount(next.visibleCount);
    allMessagesLoadedRef.current = next.allMessagesLoaded;
    setAllMessagesLoaded(next.allMessagesLoaded);
    return true;
  }, [captureViewport, chatMessages.length, totalMessages]);

  const loadOlderMessages = useCallback(async (container: HTMLDivElement) => {
    if (!container || isLoadingMoreRef.current || allMessagesLoadedRef.current) return false;

    isLoadingMoreRef.current = true;
    try {
      return revealLocalMessages(LOCAL_REVEAL_CHUNK);
    } finally {
      isLoadingMoreRef.current = false;
    }
  }, [revealLocalMessages]);

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);
    if (!searchScrollActiveRef.current) {
      if (viewportCaptureFrameRef.current) cancelAnimationFrame(viewportCaptureFrameRef.current);
      viewportCaptureFrameRef.current = requestAnimationFrame(() => {
        viewportCaptureFrameRef.current = 0;
        if (searchScrollActiveRef.current) return;
        const captured = captureViewport();
        currentViewportRef.current = nearBottom && captured?.mode === 'bottom'
          ? { mode: 'bottom', bottomDistance: 0 }
          : captured;
      });
    }

    const scrolledNearTop = container.scrollTop < 100;

    if (!allMessagesLoadedRef.current) {
      if (!scrolledNearTop) { topLoadLockRef.current = false; return; }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [captureViewport, isNearBottom, loadOlderMessages]);

  const handleViewportIntent = useCallback(() => {
    if (shouldCancelViewportSettle({ userIntent: true, applyingAutomaticScroll: applyingAutomaticScrollRef.current })) {
      cancelViewportSettle();
    }
  }, [cancelViewportSettle]);

  useLayoutEffect(() => {
    const revealAllSelectionKey = pendingRevealAllTopRef.current;
    if (revealAllSelectionKey && isSelectionCurrent(revealAllSelectionKey, selectionKeyRef.current)) {
      const container = scrollContainerRef.current;
      if (container) {
        pendingRevealAllTopRef.current = null;
        applyingAutomaticScrollRef.current = true;
        container.scrollTop = 0;
        queueMicrotask(() => { applyingAutomaticScrollRef.current = false; });
        currentViewportRef.current = captureViewport();
      }
      return;
    }
    if (!pendingScrollRestoreRef.current || !scrollContainerRef.current) return;
    const saved = pendingScrollRestoreRef.current;
    pendingScrollRestoreRef.current = null;
    const selectionKey = selectionKeyRef.current;
    if (selectionKey) startViewportSettle(saved, selectionKey);
  }, [captureViewport, chatMessages, startViewportSettle, visibleMessageCount]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    cancelViewportSettle();
    const transition = transitionViewportOwnership({
      departingIdentityKey: selectionKeyRef.current,
      arrivingIdentityKey: activeIdentityKey,
      departingViewport: currentViewportRef.current ?? captureViewport(),
      savedViewports: savedViewportsRef.current,
    });
    if (transition.save) saveBoundedViewport(savedViewportsRef.current, transition.save.key, transition.save.viewport, activeIdentityKey);
    selectionKeyRef.current = activeIdentityKey;
    if (revealAllIdentityKeyRef.current !== activeIdentityKey) revealAllIdentityKeyRef.current = null;
    pendingScrollRestoreRef.current = transition.restore;
    currentViewportRef.current = pendingScrollRestoreRef.current;
    if (!searchScrollActiveRef.current) {
      pendingInitialScrollRef.current = transition.firstOpen;
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    }
    topLoadLockRef.current = false;
    setIsUserScrolledUp(false);
    return cancelViewportSettle;
  }, [activeIdentityKey, cancelViewportSettle, captureViewport]);

  // Initial scroll to bottom — robust to lazy content reflow.
  // The previous implementation fired one scrollToBottom() at +200ms and
  // cleared the pending flag. When markdown blocks, code highlighting, or
  // images finished rendering after that window, scrollHeight grew but
  // nothing re-anchored the viewport, leaving the chat tab visually
  // "scrolled way up" with the latest assistant message off-screen.
  //
  // This version re-scrolls every animation frame while scrollHeight is
  // still growing, capped at ~1s (60 frames) or 3 consecutive stable
  // frames. Cancels cleanly on session change via the pending flag.
  useEffect(() => {
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    if (chatMessages.length === 0) { pendingInitialScrollRef.current = false; return; }
    if (searchScrollActiveRef.current) { pendingInitialScrollRef.current = false; return; }
    const selectionKey = selectionKeyRef.current;
    if (!selectionKey) return;
    pendingInitialScrollRef.current = false;
    startViewportSettle({ mode: 'bottom', bottomDistance: 0 }, selectionKey);
    return cancelViewportSettle;
  }, [cancelViewportSettle, chatMessages.length, isLoadingSessionMessages, startViewportSettle]);

  const storeSnapshot = activeSessionId
    ? sessionStore.getSessionSnapshot(activeSessionId)
    : null;
  const previousRevisionRef = useRef<{
    key: string | null;
    revision: number;
    messages: readonly NormalizedMessage[];
  }>({ key: null, revision: -1, messages: EMPTY_NORMALIZED_MESSAGES });
  useLayoutEffect(() => {
    const selectionKey = selectionKeyRef.current;
    const revision = storeSnapshot?.revision ?? -1;
    const messages = storeSnapshot?.messages ?? EMPTY_NORMALIZED_MESSAGES;
    const previous = previousRevisionRef.current;
    previousRevisionRef.current = { key: selectionKey, revision, messages };
    if (previous.key !== selectionKey) return;
    const saved = currentViewportRef.current;
    const action = getViewportRevisionAction({
      expectedIdentityKey: selectionKey,
      currentIdentityKey: activeIdentityKey,
      previousRevision: previous.revision,
      nextRevision: revision,
      previousMessages: previous.messages,
      nextMessages: messages,
      saved,
      searchActive: searchScrollActiveRef.current,
    });
    if (!saved || !selectionKey || action === 'none') return;
    if (action === 'stream-follow') {
      cancelViewportSettle();
      const container = scrollContainerRef.current;
      if (!container || !isSelectionCurrent(selectionKey, selectionKeyRef.current)) return;
      applyingAutomaticScrollRef.current = true;
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      queueMicrotask(() => { applyingAutomaticScrollRef.current = false; });
      currentViewportRef.current = { mode: 'bottom', bottomDistance: 0 };
      return;
    }
    startViewportSettle(saved.mode === 'bottom' ? { mode: 'bottom', bottomDistance: 0 } : saved, selectionKey);
  }, [activeIdentityKey, cancelViewportSettle, startViewportSettle, storeSnapshot?.messages, storeSnapshot?.revision]);

  // Main session loading effect — store-based
  useEffect(() => {
    if (!committedIdentity || !selectedProjectId) {
      sessionMessageLoadingOwnerRef.current.invalidate();
      setIsLoadingSessionMessages(false);
      resetStreamingState();
      tokenBudgetSessionRef.current = null;
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    const selectedSessionId = committedIdentity.sessionId;
    const sessionKey = committedIdentity.key;
    selectionKeyRef.current = sessionKey;
    tokenBudgetSessionRef.current = selectedSessionId;
    setViewStateIdentityKey(sessionKey);

    const subscribeToSelectedSession = () => {
      if (!ws) {
        return;
      }

      statusCheckSentAtRef.current.set(selectedSessionId, Date.now());
      sendMessage({
        type: 'chat.subscribe',
        sessions: [getSubscriptionTarget(selectedSessionId)],
      });
    };

    // Skip if already loaded and fresh
    if (lastLoadedSessionKeyRef.current === sessionKey && hasSession(selectedSessionId) && !isStale(selectedSessionId)) {
      sessionMessageLoadingOwnerRef.current.invalidate();
      setIsLoadingSessionMessages(false);
      const snapshot = getSessionSnapshot(selectedSessionId);
      setHasMoreMessages(snapshot.hasMore);
      setTotalMessages(snapshot.total);
      messagesOffsetRef.current = snapshot.offset;
      const visibility = reconcileLocalHistoryVisibility({
        identityKey: sessionKey,
        revealAllIdentityKey: revealAllIdentityKeyRef.current,
        totalMessages: snapshot.total,
        hasCompleteHistory: !snapshot.hasMore,
        initialVisibleCount: INITIAL_VISIBLE_MESSAGES,
      });
      visibleMessageCountRef.current = visibility.visibleCount;
      setVisibleMessageCount(visibility.visibleCount);
      allMessagesLoadedRef.current = visibility.allMessagesLoaded;
      setAllMessagesLoaded(allMessagesLoadedRef.current);
      if (snapshot.tokenUsage) setTokenBudget(snapshot.tokenUsage as Record<string, unknown>);
      subscribeToSelectedSession();
      return;
    }

    const sessionChanged = lastLoadedSessionKeyRef.current !== sessionKey;
    if (sessionChanged) {
      resetStreamingState();
    }

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    const resetVisibility = reconcileLocalHistoryVisibility({
      identityKey: sessionKey,
      revealAllIdentityKey: revealAllIdentityKeyRef.current,
      totalMessages: getSessionSnapshot(selectedSessionId).total,
      hasCompleteHistory: false,
      initialVisibleCount: INITIAL_VISIBLE_MESSAGES,
    });
    visibleMessageCountRef.current = resetVisibility.visibleCount;
    setVisibleMessageCount(resetVisibility.visibleCount);
    setAllMessagesLoaded(resetVisibility.allMessagesLoaded);
    allMessagesLoadedRef.current = resetVisibility.allMessagesLoaded;
    setViewHiddenCount(0);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    // Subscribe to the session's live run (if any): the ack reconciles the
    // processing indicator, re-attaches a mid-flight stream to this socket,
    // and replays any live events missed since `lastSeq`. Recording the send
    // time lets the ack handler discard idle acks that a newer request has
    // since outdated.
    subscribeToSelectedSession();

    lastLoadedSessionKeyRef.current = sessionKey;

    // Warm-up shares any anticipatory cache/network work already in flight.
    const loadingToken = sessionMessageLoadingOwnerRef.current.begin(sessionKey);
    const initialSnapshot = getSessionSnapshot(selectedSessionId);
    const warmPromise = warmSession(selectedSessionId);
    const warmedSnapshot = getSessionSnapshot(selectedSessionId);
    setIsLoadingSessionMessages(shouldBlockSessionMessageDisplay(
      warmedSnapshot.isCanonicalLoading ? warmedSnapshot : initialSnapshot,
    ));
    warmPromise.then(slot => {
       if (selectionKeyRef.current !== sessionKey || !sessionMessageLoadingOwnerRef.current.isCurrent(loadingToken, sessionKey)) return;
      if (slot) {
        // Ordinary opens always request the complete transcript.
        const hasAuthoritativeHistory = slot.fetchedAt > 0;
        // Cached rows can exist while the authoritative request is still
        // loading (or after it fails). Keep this state incomplete until the
        // store records a successful network fetch.
        setHasMoreMessages(!hasAuthoritativeHistory);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.serverMessages.length;
        const visibility = reconcileLocalHistoryVisibility({
          identityKey: sessionKey,
          revealAllIdentityKey: revealAllIdentityKeyRef.current,
          totalMessages: slot.total,
          hasCompleteHistory: hasAuthoritativeHistory,
          initialVisibleCount: INITIAL_VISIBLE_MESSAGES,
        });
        visibleMessageCountRef.current = visibility.visibleCount;
        setVisibleMessageCount(visibleMessageCountRef.current);
        allMessagesLoadedRef.current = visibility.allMessagesLoaded;
        setAllMessagesLoaded(visibility.allMessagesLoaded);
        if (slot.tokenUsage && tokenBudgetSessionRef.current === selectedSessionId) {
          setTokenBudget(slot.tokenUsage as Record<string, unknown>);
        }
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      if (selectionKeyRef.current !== sessionKey || !sessionMessageLoadingOwnerRef.current.isCurrent(loadingToken, sessionKey)) return;
      setIsLoadingSessionMessages(false);
    });
  }, [
    resetStreamingState,
    selectedProjectId,
    committedIdentity,
    sendMessage,
    statusCheckSentAtRef,
    connectionEpoch,
    ws,
    getSubscriptionTarget,
    hasSession,
    isStale,
    getSessionSnapshot,
    warmSession,
    setTokenBudget,
  ]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !committedIdentity || !selectedProjectId) return;
    const requestKey = committedIdentity.key;
    const sessionId = committedIdentity.sessionId;
    if (!externalSessionRefreshOwnerRef.current.consume(requestKey, externalMessageUpdate, isProcessing)) return;
    const saved = currentViewportRef.current ?? captureViewport();
    if (saved) currentViewportRef.current = saved;

    const reloadExternalMessages = async () => {
      try {
        await refreshFromServer(sessionId);
        if (!isSelectionCurrent(requestKey, selectionKeyRef.current) || searchScrollActiveRef.current) return;
        if (saved) startViewportSettle(saved, requestKey);
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    captureViewport,
    selectedProjectId,
    committedIdentity,
    refreshFromServer,
    startViewportSettle,
    isProcessing,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      cancelViewportSettle();
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [cancelViewportSettle, selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    const searchKey = selectionKeyRef.current;
    const searchSessionId = selectedSession?.id;
    const schedule = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        searchTimersRef.current.delete(timer);
        if (isSelectionCurrent(searchKey, selectionKeyRef.current)) callback();
      }, delay);
      searchTimersRef.current.add(timer);
    };
    const finishSearch = () => {
      if (isSelectionCurrent(searchKey, selectionKeyRef.current)) {
        searchScrollActiveRef.current = false;
        currentViewportRef.current = captureViewport();
        setSearchTarget(null);
      }
    };

    const scrollToTarget = async () => {
      const slot = selectedSession ? sessionStore.getSessionSlot(selectedSession.id) : undefined;
      const hasAuthoritativeCompleteHistory = Boolean(slot && slot.fetchedAt > 0 && !slot.hasMore);
      if (!hasAuthoritativeCompleteHistory && selectedSession && selectedProject) {
        try {
          // Retry only when the current slot is incomplete or failed. A
          // successful ordinary open already loaded the complete transcript.
          const refreshedSlot = await sessionStore.fetchFromServer(selectedSession.id);
          if (!isSelectionCurrent(searchKey, selectionKeyRef.current) || selectedSession.id !== searchSessionId) return;
          if (refreshedSlot?.fetchedAt && !refreshedSlot.hasMore) {
            setHasMoreMessages(false);
            setTotalMessages(refreshedSlot.total);
            messagesOffsetRef.current = refreshedSlot.serverMessages.length;
          }
        } catch {
          // Fall through and scroll in currently loaded messages.
        }
      }
      const completeCount = Math.max(chatMessages.length, sessionStore.getSessionSlot(selectedSession?.id || '')?.total ?? 0);
      visibleMessageCountRef.current = completeCount;
      setVisibleMessageCount(completeCount);
      if (hasAuthoritativeCompleteHistory || sessionStore.getSessionSlot(selectedSession?.id || '')?.fetchedAt) {
        allMessagesLoadedRef.current = true;
        setAllMessagesLoaded(true);
      }

      const findAndScroll = (retriesLeft: number) => {
        if (!isSelectionCurrent(searchKey, selectionKeyRef.current)) return;
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();
          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) { targetElement = el; break; }
            }
          }
        }

        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;
          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) { closestDiff = diff; targetElement = el; }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          schedule(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          finishSearch();
        } else if (retriesLeft > 0) {
          schedule(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          finishSearch();
        }
      };

      schedule(() => findAndScroll(15), 150);
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingSessionMessages, searchTarget]);

  useEffect(() => () => {
    if (viewportCaptureFrameRef.current) cancelAnimationFrame(viewportCaptureFrameRef.current);
    for (const timer of searchTimersRef.current) clearTimeout(timer);
    searchTimersRef.current.clear();
    searchScrollActiveRef.current = false;
  }, [selectedProject?.projectId, selectedSession?.id]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!committedIdentity) {
      setTokenBudget(null);
      return;
    }
    const fetchInitialTokenUsage = async () => {
      const requestSessionId = committedIdentity.sessionId;
      const requestKey = committedIdentity.key;
      try {
        // The provider module resolves storage and provider details from the session id.
        const url = `/api/providers/sessions/${encodeURIComponent(requestSessionId)}/token-usage`;
        const response = await authenticatedFetch(url);
        if (response.ok && tokenBudgetSessionRef.current === requestSessionId && selectionKeyRef.current === requestKey) {
          const payload = await response.json();
          if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
            setTokenBudget(payload.data as Record<string, unknown>);
          }
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [committedIdentity, setTokenBudget]);

  const committedVisibleMessageCount = viewStateIdentityKey === activeIdentityKey
    ? (revealAllIdentityKeyRef.current === activeIdentityKey ? Infinity : visibleMessageCount)
    : INITIAL_VISIBLE_MESSAGES;
  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= committedVisibleMessageCount) return chatMessages;
    return chatMessages.slice(-committedVisibleMessageCount);
  }, [chatMessages, committedVisibleMessageCount]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const loadAllMessages = useCallback(() => {
    if (!selectedSession || !selectedProject) return;
    const selectionKey = selectionKeyRef.current;
    if (!selectionKey) return;
    cancelViewportSettle();
    pendingScrollRestoreRef.current = null;
    pendingRevealAllTopRef.current = selectionKey;
    revealAllIdentityKeyRef.current = selectionKey;
    const reveal = revealAllLocalHistory(chatMessages.length);
    visibleMessageCountRef.current = reveal.visibleCount;
    setVisibleMessageCount(reveal.visibleCount);
    allMessagesLoadedRef.current = reveal.allMessagesLoaded;
    setAllMessagesLoaded(reveal.allMessagesLoaded);
  }, [cancelViewportSettle, chatMessages.length, selectedProject, selectedSession]);

  const loadEarlierMessages = useCallback(() => {
    revealLocalMessages(LOCAL_REVEAL_CHUNK);
  }, [revealLocalMessages]);

  return {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    establishDraftSession,
    isLoadingSessionMessages: viewStateIdentityKey === activeIdentityKey ? isLoadingSessionMessages : false,
    isLoadingMoreMessages: false,
    hasMoreMessages: viewStateIdentityKey === activeIdentityKey ? hasMoreMessages : false,
    totalMessages: viewStateIdentityKey === activeIdentityKey ? totalMessages : chatMessages.length,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget: viewStateIdentityKey === activeIdentityKey ? tokenBudget : null,
    setTokenBudget,
    visibleMessageCount: committedVisibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages: false,
    loadAllJustFinished: false,
    showLoadAllOverlay: false,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
    handleViewportIntent,
  };
}
