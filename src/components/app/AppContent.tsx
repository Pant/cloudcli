import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useWebSocket } from '../../contexts/useWebSocket';
import { PaletteOpsProvider } from '../../contexts/PaletteOpsContext';
import { usePaletteOpsRegister } from '../../contexts/paletteOps';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { apiClient } from '../../utils/apiClient';
import type {
  LLMProvider,
  ProjectSession,
  RunningSessionAncestorSnapshot,
  RunningSessionSnapshot,
  SessionLifecycleSnapshot,
  SessionLifecycleStatus,
} from '../../types/app';
import ErrorBoundary from '../main-content/view/ErrorBoundary';
import { markCloudCliLifecycle } from '../../lib/performanceDiagnostics';
import { useAuth } from '../auth/context/authContextContract';

import { createSessionActivitySyncController, getSessionActivityPollInterval, isLifecycleRelevantEvent } from './sessionActivitySync';

const Sidebar = lazy(() => import('../sidebar/view/Sidebar'));
const MainContent = lazy(() => import('../main-content/view/MainContent'));
const CommandPaletteTrigger = lazy(() => import('../command-palette/CommandPaletteTrigger'));
const QuickSettingsPanelTrigger = lazy(() => import('../quick-settings-panel/view/QuickSettingsPanelTrigger'));

function AppSurfaceLoadingState() {
  return (
    <div className="flex h-full w-full items-center justify-center" role="status" aria-label="Loading">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
    </div>
  );
}

const lifecycleStatuses = new Set<SessionLifecycleStatus>(['running', 'recovering', 'stalled', 'exited', 'failed', 'manually_stopped', 'recovery_exhausted']);
const notificationReplyIntentKey = 'cloudcli:notification-reply-intent';
const notificationReplyEvent = 'cloudcli:notification-reply';

const forwardNotificationReplyIntent = (sessionId: string) => {
  try {
    sessionStorage.setItem(notificationReplyIntentKey, JSON.stringify({ sessionId, createdAt: Date.now() }));
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
  window.dispatchEvent(new CustomEvent(notificationReplyEvent, { detail: { sessionId } }));
};

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseRunningAncestor = (value: unknown): RunningSessionAncestorSnapshot | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as RunningSessionAncestorSnapshot;
  if (typeof item.sessionId !== 'string' || !item.sessionId) {
    return null;
  }

  const session = item.session && typeof item.session === 'object'
    ? {
      ...(item.session as ProjectSession),
      id: typeof item.session.id === 'string' && item.session.id ? item.session.id : item.sessionId,
      provider: item.session.provider ?? item.provider,
      ...(typeof item.parentSessionId === 'string' || item.parentSessionId === null
        ? { parentSessionId: item.parentSessionId }
        : {}),
    }
    : null;

  return {
    sessionId: item.sessionId,
    provider: typeof item.provider === 'string' ? item.provider as LLMProvider : session?.provider,
    parentSessionId: typeof item.parentSessionId === 'string'
      ? item.parentSessionId
      : item.parentSessionId === null
        ? null
        : session?.parentSessionId,
    session,
    project: item.project && typeof item.project === 'object' ? item.project : null,
  };
};

const parseRunningSession = (value: RunningSessionSnapshot): RunningSessionSnapshot | null => {
  if (typeof value.sessionId !== 'string' || !value.sessionId) {
    return null;
  }

  const session = value.session && typeof value.session === 'object'
    ? {
      ...(value.session as ProjectSession),
      id: typeof value.session.id === 'string' && value.session.id ? value.session.id : value.sessionId,
      provider: value.session.provider ?? value.provider,
      parentSessionId: value.parentSessionId ?? value.session.parentSessionId,
    }
    : null;

  return {
    sessionId: value.sessionId,
    provider: typeof value.provider === 'string' ? value.provider as LLMProvider : session?.provider,
    parentSessionId: typeof value.parentSessionId === 'string' ? value.parentSessionId : value.parentSessionId === null ? null : session?.parentSessionId,
    startedAt: parseStartedAt(value.startedAt),
    status: typeof value.status === 'string' ? value.status : 'running',
    statusText: typeof value.statusText === 'string' || value.statusText === null ? value.statusText : undefined,
    canInterrupt: typeof value.canInterrupt === 'boolean' ? value.canInterrupt : undefined,
    lastSeq: typeof value.lastSeq === 'number' && Number.isFinite(value.lastSeq) ? value.lastSeq : undefined,
    session,
    project: value.project && typeof value.project === 'object' ? value.project : null,
    ancestors: Array.isArray(value.ancestors)
      ? value.ancestors.map(parseRunningAncestor).filter((ancestor): ancestor is RunningSessionAncestorSnapshot => Boolean(ancestor))
      : undefined,
  };
};

const parseLifecycleSession = (value: unknown): SessionLifecycleSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.sessionId !== 'string' || !item.sessionId || typeof item.status !== 'string' || !lifecycleStatuses.has(item.status as SessionLifecycleStatus)) return null;
  const context = parseRunningAncestor(value);
  if (!context) return null;
  return {
    ...context,
    status: item.status as SessionLifecycleStatus,
    statusText: typeof item.statusText === 'string' || item.statusText === null ? item.statusText : null,
    lastActivityAt: parseStartedAt(item.lastActivityAt) ?? 0,
    restartable: item.restartable === true,
    canInterrupt: item.canInterrupt === true,
    terminalReason: typeof item.terminalReason === 'string' ? item.terminalReason as SessionLifecycleSnapshot['terminalReason'] : null,
    exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
    ancestors: Array.isArray(item.ancestors) ? item.ancestors.map(parseRunningAncestor).filter((ancestor): ancestor is NonNullable<typeof ancestor> => Boolean(ancestor)) : undefined,
  };
};

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const { isOfflineSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const sessionId = useMatch('/session/:sessionId')?.params.sessionId;
  const projectRouteId = useMatch('/project/:projectId/new')?.params.projectId;
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe, connectionEpoch } = useWebSocket();
  const activitySyncRef = useRef<ReturnType<typeof createSessionActivitySyncController> | null>(null);
  const activitySyncGenerationRef = useRef(0);
  const startingSessionIdsRef = useRef(new Set<string>());

  useEffect(() => { markCloudCliLifecycle('app-shell-ready'); }, []);

  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
    sessionLifecycle,
    syncSessionLifecycle,
  } = useSessionProtection();

  const {
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    openSettings,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleNewSession,
    handleProjectSelect,
  } = useProjectsState({
    sessionId,
    projectRouteId,
    navigate,
    subscribe,
    isMobile,
    activeSessions: processingSessions,
    lifecycleSessions: sessionLifecycle,
  });

  // Queued messages for sessions that finish while another session (or none)
  // is being viewed are sent from here; the viewed session's composer handles
  // its own queue.
  useQueuedMessageAutoSend({
    processingSessions,
    activeSessionId: selectedSession?.id ?? sessionId ?? null,
    ws,
    sendMessage,
    markSessionProcessing,
  });

  const refreshRunningSessions = useCallback(async () => {
    const generation = activitySyncGenerationRef.current;
    try {
       const [sessions, lifecycleSessions] = await Promise.all([apiClient.runningSessions(), apiClient.sessionLifecycleStatus()]);
       const runningSnapshots = sessions.map(parseRunningSession).filter((session): session is NonNullable<typeof session> => Boolean(session));
       const lifecycleSnapshots = lifecycleSessions.map(parseLifecycleSession).filter((item): item is SessionLifecycleSnapshot => Boolean(item));
      if (!activitySyncRef.current || activitySyncGenerationRef.current !== generation) return;
      syncProcessingSessions(
        runningSnapshots,
      );
      syncSessionLifecycle(lifecycleSnapshots);
    } catch (error) {
      console.error('[AppContent] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions, syncSessionLifecycle]);

  const startSession = useCallback(async (targetSessionId: string) => {
    if (startingSessionIdsRef.current.has(targetSessionId)) return;
    startingSessionIdsRef.current.add(targetSessionId);
    const actionId = globalThis.crypto?.randomUUID?.() ?? `start_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      await apiClient.startSession(targetSessionId, { clientMutationId: actionId }, { idempotencyKey: actionId });
      activitySyncRef.current?.invalidate(true);
    } finally {
      startingSessionIdsRef.current.delete(targetSessionId);
    }
  }, []);

  useEffect(() => {
    activitySyncGenerationRef.current += 1;
    const controller = createSessionActivitySyncController({ refresh: refreshRunningSessions });
    activitySyncRef.current = controller;
    const unsubscribe = subscribe((event) => {
      if (isLifecycleRelevantEvent(event)) controller.invalidate();
    });
    const refreshOnFocus = () => controller.invalidate(true);
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') controller.invalidate(true);
    };
    const refreshOnOnline = () => controller.invalidate(true);
    window.addEventListener('focus', refreshOnFocus);
    window.addEventListener('online', refreshOnOnline);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    controller.invalidate(true);
    return () => {
      activitySyncGenerationRef.current += 1;
      activitySyncRef.current = null;
      controller.dispose();
      unsubscribe();
      window.removeEventListener('focus', refreshOnFocus);
      window.removeEventListener('online', refreshOnOnline);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, [refreshRunningSessions, subscribe]);

  useEffect(() => {
    if (connectionEpoch > 0) activitySyncRef.current?.invalidate(true);
  }, [connectionEpoch]);

  useEffect(() => {
    activitySyncRef.current?.setPollInterval(getSessionActivityPollInterval(
      processingSessions.size,
      [...sessionLifecycle.values()].map((snapshot) => snapshot.status),
    ));
  }, [processingSessions, sessionLifecycle]);

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        if (message.reply === true) {
          forwardNotificationReplyIntent(message.sessionId);
        }
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  useEffect(() => {
    const search = new URLSearchParams(location.search);
    if (search.get('notificationReply') !== '1' || !sessionId) return;

    forwardNotificationReplyIntent(sessionId);
    search.delete('notificationReply');
    navigate(`${location.pathname}${search.size ? `?${search.toString()}` : ''}`, { replace: true });
  }, [location.pathname, location.search, navigate, sessionId]);

  // Pending tool permissions are recovered through the `chat.subscribe` flow:
  // the `chat_subscribed` ack carries them on session open and on reconnect,
  // so no separate permission-recovery message is needed here.

  // Adjust the app container to stay above the virtual keyboard on iOS Safari.
  // On Chrome for Android the layout viewport already shrinks when the keyboard opens,
  // so inset-0 adjusts automatically. On iOS the layout viewport stays full-height and
  // the keyboard overlays it — we use the Visual Viewport API to track keyboard height
  // and apply it as a CSS variable that shifts the container's bottom edge up.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const kb = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  return (
    <div className="fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      {isOfflineSession && <div className="fixed left-1/2 top-2 z-[100] flex max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-400 bg-amber-50 px-4 py-2 text-sm text-amber-950 shadow-lg" role="status">
        <span>Offline read-only mode. Saved projects, sessions, drafts, and recovery data remain available; server actions will not be delivered.</span>
      </div>}
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Suspense fallback={<AppSurfaceLoadingState />}>
            <ErrorBoundary area="sidebar" name="Sidebar" onRetry={() => void refreshProjectsSilently()} resetKeys={[isLoadingProjects]}><Sidebar {...sidebarSharedProps} sessionLifecycle={sessionLifecycle} onStartSession={startSession} /></ErrorBoundary>
          </Suspense>
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Suspense fallback={<AppSurfaceLoadingState />}>
              <ErrorBoundary area="sidebar" name="Sidebar" onRetry={() => void refreshProjectsSilently()} resetKeys={[isLoadingProjects]}><Sidebar {...sidebarSharedProps} sessionLifecycle={sessionLifecycle} onStartSession={startSession} /></ErrorBoundary>
            </Suspense>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<AppSurfaceLoadingState />}>
          <MainContent
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            ws={ws}
            sendMessage={sendMessage}
            isMobile={isMobile}
            onMenuClick={() => setSidebarOpen(true)}
            isLoading={isLoadingProjects}
            onInputFocusChange={setIsInputFocused}
            onSessionProcessing={markSessionProcessing}
            onSessionIdle={markSessionIdle}
            processingSessions={processingSessions}
            onNavigateToSession={(targetSessionId: string, options) =>
              navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
            }
            onSessionEstablished={(targetSessionId, context) =>
              registerOptimisticSession({ sessionId: targetSessionId, ...context })
            }
            onShowSettings={openSettings}
            externalMessageUpdate={externalMessageUpdate}
            newSessionTrigger={newSessionTrigger}
            onProjectSelect={handleProjectSelect}
            onProjectsRefresh={() => void refreshProjectsSilently()}
          />
        </Suspense>
      </div>

      <Suspense fallback={null}>
        <CommandPaletteTrigger
          selectedProject={selectedProject}
          onStartNewChat={handleNewSession}
          onOpenSettings={() => openSettings()}
          onShowTab={setActiveTab}
        />
      </Suspense>

      <Suspense fallback={null}>
        <QuickSettingsPanelTrigger />
      </Suspense>
    </div>
  );
}
