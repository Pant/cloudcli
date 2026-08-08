import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useWebSocket } from '../../contexts/useWebSocket';
import { PaletteOpsProvider } from '../../contexts/PaletteOpsContext';
import { usePaletteOpsRegister } from '../../contexts/paletteOps';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { api } from '../../utils/api';
import type {
  LLMProvider,
  ProjectSession,
  RunningSessionAncestorSnapshot,
  RunningSessionSnapshot,
  SessionLifecycleSnapshot,
  SessionLifecycleStatus,
} from '../../types/app';

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

type RunningSessionApiItem = RunningSessionSnapshot & { sessionId?: unknown };

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

type LifecycleSessionsApiPayload = { data?: { sessions?: unknown[] } };
const lifecycleStatuses = new Set<SessionLifecycleStatus>(['running', 'recovering', 'stalled', 'exited', 'failed', 'manually_stopped', 'recovery_exhausted']);

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

const parseRunningSession = (value: RunningSessionApiItem): RunningSessionSnapshot | null => {
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
  const navigate = useNavigate();
  const sessionId = useMatch('/session/:sessionId')?.params.sessionId;
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe, connectionEpoch } = useWebSocket();
  const activitySyncRef = useRef<ReturnType<typeof createSessionActivitySyncController> | null>(null);
  const activitySyncGenerationRef = useRef(0);

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
      const [response, lifecycleResponse] = await Promise.all([api.runningSessions(), api.sessionLifecycleStatus()]);
      if (!response.ok || !lifecycleResponse.ok) return;
      const payload = (await response.json()) as RunningSessionsApiPayload;
      const lifecyclePayload = (await lifecycleResponse.json()) as LifecycleSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];
      const runningSnapshots = sessions.map(parseRunningSession).filter((session): session is NonNullable<typeof session> => Boolean(session));
      const lifecycleSnapshots = (lifecyclePayload.data?.sessions ?? []).map(parseLifecycleSession).filter((item): item is SessionLifecycleSnapshot => Boolean(item));
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
    const response = await api.startSession(targetSessionId);
    if (!response.ok) throw new Error(`Failed to start session (${response.status})`);
    activitySyncRef.current?.invalidate(true);
  }, []);

  useEffect(() => {
    activitySyncGenerationRef.current += 1;
    const controller = createSessionActivitySyncController({ refresh: refreshRunningSessions });
    activitySyncRef.current = controller;
    const unsubscribe = subscribe((event) => {
      if (isLifecycleRelevantEvent(event)) controller.invalidate();
    });
    const refreshOnFocus = () => controller.invalidate();
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') controller.invalidate();
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    controller.invalidate(true);
    return () => {
      activitySyncGenerationRef.current += 1;
      activitySyncRef.current = null;
      controller.dispose();
      unsubscribe();
      window.removeEventListener('focus', refreshOnFocus);
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
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Suspense fallback={<AppSurfaceLoadingState />}>
            <Sidebar {...sidebarSharedProps} sessionLifecycle={sessionLifecycle} onStartSession={startSession} />
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
              <Sidebar {...sidebarSharedProps} sessionLifecycle={sessionLifecycle} onStartSession={startSession} />
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
