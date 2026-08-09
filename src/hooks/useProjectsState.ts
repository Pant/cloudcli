import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { api, authenticatedFetch } from '../utils/api';
import type { ServerEvent } from '../contexts/webSocketTypes';
import type {
  AppTab,
  LLMProvider,
  LoadingProgress,
  Project,
  ProjectSession,
} from '../types/app';
import { KeyedServerState } from '../lib/serverState';

import type { SessionActivityMap, SessionLifecycleMap } from './useSessionProtection';
import {
  getProjectSessions,
  mergeExpandedSessionPages,
  mergeProjectSessionPage,
  mergeRunningSnapshotsIntoProjects,
  sessionHistoryRevision,
  shouldSignalExternalHistoryRefresh,
  upsertSessionIntoProject,
} from './projectStateUtils';

type UseProjectsStateArgs = {
  sessionId?: string;
  projectRouteId?: string;
  navigate: NavigateFunction;
  /** Subscription to the unified websocket event stream. */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  isMobile: boolean;
  activeSessions: SessionActivityMap;
  lifecycleSessions?: SessionLifecycleMap;
};

/**
 * Shape of the per-session sidebar delta broadcast by the backend file
 * watcher (`kind: session_upserted`). It carries everything needed to upsert
 * one session row in place — no full project-list snapshot is ever pushed.
 */
type SessionUpsertedEvent = ServerEvent & {
  sessionId: string;
  provider: LLMProvider;
  session: ProjectSession;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
  } | null;
};

type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

type RegisterOptimisticSessionArgs = {
  sessionId: string;
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

type NewSessionIntentActions = {
  selectProject: (project: Project) => void;
  clearSession: () => void;
  showChat: () => void;
  triggerReset: () => void;
  navigateToDraft: (project: Project) => void;
  closeSidebar?: () => void;
};

type SessionSelectionIntentActions = {
  selectProject: (project: Project) => void;
  selectSession: (session: ProjectSession) => void;
  clearAttention: (sessionId: string) => void;
  showChat?: () => void;
  navigateToSession: (sessionId: string) => void;
  closeSidebar?: () => void;
};

export const applyNewSessionIntent = (project: Project, actions: NewSessionIntentActions) => {
  actions.selectProject(project);
  actions.clearSession();
  actions.showChat();
  actions.triggerReset();
  actions.navigateToDraft(project);
  actions.closeSidebar?.();
};

export const applySessionSelectionIntent = (
  project: Project,
  session: ProjectSession,
  actions: SessionSelectionIntentActions,
) => {
  actions.clearAttention(session.id);
  actions.selectProject(project);
  actions.selectSession(session);
  actions.showChat?.();
  actions.navigateToSession(session.id);
  actions.closeSidebar?.();
};

export const getProjectDraftUrl = (projectId: string) =>
  `/project/${encodeURIComponent(projectId)}/new`;

export const resolveProjectRoute = (projectRouteId: string | undefined, projects: Project[]) =>
  projectRouteId ? projects.find((project) => project.projectId === projectRouteId) ?? null : null;

/**
 * Shape of `GET /api/providers/sessions/:sessionId` — the authoritative
 * session → owning-project resolution used when a `/session/<id>` URL points
 * at a session that is not present in the paginated project payloads.
 */
type SessionDetailsApiPayload = {
  data?: {
    sessionId?: string;
    provider?: string;
    model?: string | null;
    agent?: string | null;
    summary?: string;
    createdAt?: string | null;
    lastActivity?: string | null;
    parentSessionId?: string | null;
    project?: {
      projectId?: string;
      path?: string;
      fullPath?: string;
      displayName?: string;
      isStarred?: boolean;
    } | null;
  };
};

type ProjectSessionPage = Pick<Project, 'sessions' | 'sessionMeta'>;

const DEFAULT_PROVIDER: LLMProvider = 'claude';

const serialize = (value: unknown) => JSON.stringify(value ?? null);

const readSelectedProvider = (): LLMProvider => {
  try {
    const storedProvider = localStorage.getItem('selected-provider');
    return storedProvider ? storedProvider as LLMProvider : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : DEFAULT_PROVIDER;
};

const normalizeSessionProvider = (session: ProjectSession): ProjectSession => ({
  ...session,
  __provider: getSessionProvider(session),
});

const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    return (
      nextProject.projectId !== prevProject.projectId ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      Boolean(nextProject.isStarred) !== Boolean(prevProject.isStarred) ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions)
    );
  });
};

const projectFromRegistration = (project: Project): Project => ({
  projectId: project.projectId,
  path: project.path || project.fullPath,
  fullPath: project.fullPath || project.path || '',
  displayName: project.displayName,
  isStarred: project.isStarred,
  sessions: project.sessions ?? [],
  sessionMeta: project.sessionMeta ?? { hasMore: false, total: getProjectSessions(project).length },
});

const removeSessionFromProject = (project: Project, sessionIdToDelete: string): Project => {
  const sessions = project.sessions ?? [];
  const nextSessions = sessions.filter((session) => session.id !== sessionIdToDelete);
  if (nextSessions.length === sessions.length) {
    return project;
  }

  const updatedProject: Project = {
    ...project,
    sessions: nextSessions,
  };

  const totalSessions = Math.max(0, Number(project.sessionMeta?.total ?? 0) - 1);
  updatedProject.sessionMeta = {
    ...project.sessionMeta,
    total: totalSessions,
    hasMore: getProjectSessions(updatedProject).length < totalSessions,
  };

  return updatedProject;
};

const VALID_TABS: Set<string> = new Set(['chat', 'files', 'shell', 'git', 'browser']);

const isValidTab = (tab: string): tab is AppTab => {
  return VALID_TABS.has(tab) || tab.startsWith('plugin:');
};

const readPersistedTab = (): AppTab => {
  try {
    const stored = localStorage.getItem('activeTab');
    if (stored && isValidTab(stored)) {
      return stored as AppTab;
    }
  } catch {
    // localStorage unavailable
  }
  return 'chat';
};

export function useProjectsState({
  sessionId,
  projectRouteId,
  navigate,
  subscribe,
  isMobile,
  activeSessions,
  lifecycleSessions = new Map(),
}: UseProjectsStateArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [attentionSessionIds, setAttentionSessionIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<AppTab>(readPersistedTab);
  const projectOwnerRef = useRef<KeyedServerState<'root', Project[]> | null>(null);
  if (!projectOwnerRef.current) {
    projectOwnerRef.current = new KeyedServerState(async (_key, signal) => {
      const response = await authenticatedFetch('/api/projects', { signal });
      if (!response.ok) throw new Error(`Failed to fetch projects (${response.status})`);
      return response.json() as Promise<Project[]>;
    }, 1_000);
  }

  useEffect(() => {
    try {
      localStorage.setItem('activeTab', activeTab);
    } catch {
      // Silently ignore storage errors
    }
  }, [activeTab]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);
  /**
   * `newSessionTrigger` is an explicit, monotonic intent signal for user-driven
   * New Session actions.
   *
   * It exists because `handleNewSession` can be invoked while the app is already in
   * the same visible state (`selectedSession === null`, `activeTab === 'chat'`,
   * route already `/`). In that case, React/router updates are idempotent and no
   * downstream reset logic runs.
   *
   * Usage across the codebase:
   * 1) Produced here in `handleNewSession` via increment (always changes).
   * 2) Returned from this hook and threaded through:
   *    useProjectsState -> AppContent -> MainContent -> ChatInterface.
   * 3) Consumed in `useChatSessionState` as an effect dependency to forcibly clear
   *    chat-local state (`currentSessionId`, pending draft message, streaming flags,
   *    pending session storage keys, pagination/scroll artifacts).
   *
   * Keeping this signal dedicated avoids coupling resets to unrelated counters/events
   * (for example websocket/project refresh updates) that could cause accidental resets.
   */
  const [newSessionTrigger, setNewSessionTrigger] = useState(0);

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Ref mirrors for state the websocket subscription handler needs.
   *
   * The subscription is registered once (per `subscribe` identity) and events
   * are dispatched synchronously outside React's render cycle, so the handler
   * must read the latest values through refs instead of stale closures —
   * re-subscribing on every state change would risk missing events.
   */
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  const activeSessionsRef = useRef(activeSessions);
  activeSessionsRef.current = activeSessions;
  const lastExternalHistoryRevisionRef = useRef(new Map<string, string>());
  const selectedProjectRef = useRef(selectedProject);
  selectedProjectRef.current = selectedProject;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  /** URL session id whose backend lookup already ran (or is in flight) — one attempt per id. */
  const sessionLookupRef = useRef<string | null>(null);

  useEffect(() => {
    sessionLookupRef.current = null;
  }, [sessionId]);

  const markSessionAttention = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) {
      return;
    }

    const viewedSessionId = selectedSessionRef.current?.id ?? sessionId ?? null;
    if (targetSessionId === viewedSessionId) {
      return;
    }

    setAttentionSessionIds((previous) => {
      if (previous.has(targetSessionId)) {
        return previous;
      }

      const next = new Set(previous);
      next.add(targetSessionId);
      return next;
    });
  }, [sessionId]);

  const clearSessionAttention = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) {
      return;
    }

    setAttentionSessionIds((previous) => {
      if (!previous.has(targetSessionId)) {
        return previous;
      }

      const next = new Set(previous);
      next.delete(targetSessionId);
      return next;
    });
  }, []);

  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}) => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const projectData = await projectOwnerRef.current!.read('root');

      setProjects((prevProjects) => {
        const mergedProjects = mergeExpandedSessionPages(prevProjects, projectData);

        if (prevProjects.length === 0) {
          return mergedProjects;
        }

        return projectsHaveChanges(prevProjects, mergedProjects)
          ? mergedProjects
          : prevProjects;
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  useEffect(() => () => projectOwnerRef.current?.dispose(), []);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  const registerOptimisticSession = useCallback(({
    sessionId: newSessionId,
    provider,
    project,
    summary,
  }: RegisterOptimisticSessionArgs) => {
    if (!newSessionId || !project?.projectId) {
      return;
    }

    const now = new Date().toISOString();
    const optimisticSession: ProjectSession = {
      id: newSessionId,
      summary: summary ?? '',
      messageCount: 0,
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
      __provider: provider,
      __projectId: project.projectId,
    };
    const upsert: SessionUpsertedEvent = {
      kind: 'session_upserted',
      sessionId: newSessionId,
      provider,
      session: optimisticSession,
      project: {
        projectId: project.projectId,
        path: project.path || project.fullPath,
        fullPath: project.fullPath || project.path || '',
        displayName: project.displayName,
        isStarred: Boolean(project.isStarred),
      },
      timestamp: now,
    };

    setProjects((previousProjects) => {
      const existingProject = previousProjects.find((candidate) => candidate.projectId === project.projectId);
      if (!existingProject) {
        return [upsertSessionIntoProject(projectFromRegistration(project), upsert), ...previousProjects];
      }

      const updatedProject = upsertSessionIntoProject(existingProject, upsert);
      if (updatedProject === existingProject) {
        return previousProjects;
      }

      return previousProjects.map((candidate) =>
        candidate.projectId === existingProject.projectId ? updatedProject : candidate,
      );
    });

    setSelectedProject((previousProject) => {
      if (!previousProject || previousProject.projectId !== project.projectId) {
        return previousProject;
      }

      const updatedProject = upsertSessionIntoProject(previousProject, upsert);
      return updatedProject === previousProject ? previousProject : updatedProject;
    });

    setSelectedSession((previousSession) => (
      previousSession?.id === newSessionId
        ? { ...previousSession, ...optimisticSession }
        : optimisticSession
    ));
  }, []);

  const openSettings = useCallback((tab = 'tools') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  // The running endpoint carries canonical session/project summaries for rows
  // that may not belong to the currently loaded root page. Hydrate those rows
  // into the same project state used by the sidebar, but keep all pagination
  // metadata untouched so an off-page child cannot advance the root cursor.
  useEffect(() => {
    if (activeSessions.size === 0 && lifecycleSessions.size === 0) {
      return;
    }

    const hydrationSnapshots = new Map<string, import('./useSessionProtection').SessionActivity | import('../types/app').RunningSessionSnapshot>(activeSessions);
    for (const [id, snapshot] of lifecycleSessions) {
      if (!hydrationSnapshots.has(id)) hydrationSnapshots.set(id, snapshot);
    }

    setProjects((previousProjects) => {
      const merged = mergeRunningSnapshotsIntoProjects(previousProjects, hydrationSnapshots);
      return projectsHaveChanges(previousProjects, merged) ? merged : previousProjects;
    });

    setSelectedProject((previousProject) => {
      if (!previousProject) {
        return previousProject;
      }
      const merged = mergeRunningSnapshotsIntoProjects([previousProject], hydrationSnapshots)[0];
      return merged && serialize(merged) !== serialize(previousProject) ? merged : previousProject;
    });
  }, [activeSessions, lifecycleSessions]);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId && !projectRouteId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projectRouteId, projects, selectedProject, sessionId]);

  useEffect(() => {
    if (!projectRouteId) return;

    const routeProject = resolveProjectRoute(projectRouteId, projects);
    setSelectedSession((previousSession) => previousSession === null ? previousSession : null);
    setSelectedProject((previousProject) =>
      previousProject?.projectId === routeProject?.projectId ? previousProject : routeProject,
    );
  }, [projectRouteId, projects]);

  // Realtime sidebar updates. The backend pushes per-session deltas
  // (`session_upserted`) instead of full project snapshots, so each event is
  // a keyed upsert that can never clobber unrelated client state — no
  // "suppress updates while a run is active" protection is needed anymore.
  useEffect(() => {
    const handleEvent = (event: ServerEvent) => {
      if (event.kind === 'loading_progress') {
        if (loadingProgressTimeoutRef.current) {
          clearTimeout(loadingProgressTimeoutRef.current);
          loadingProgressTimeoutRef.current = null;
        }

        setLoadingProgress(event as unknown as LoadingProgress);

        if (event.phase === 'complete') {
          loadingProgressTimeoutRef.current = setTimeout(() => {
            setLoadingProgress(null);
            loadingProgressTimeoutRef.current = null;
          }, 500);
        }

        return;
      }

      const eventSessionId = typeof event.sessionId === 'string' && event.sessionId
        ? event.sessionId
        : null;
      const viewedSessionId = selectedSessionRef.current?.id ?? sessionId ?? null;

      if (
        eventSessionId
        && eventSessionId !== viewedSessionId
        && event.kind !== 'chat_subscribed'
        && event.kind !== 'loading_progress'
        && event.kind !== 'session_upserted'
        && event.kind !== 'status'
        && event.kind !== 'stream_end'
        && event.kind !== 'permission_cancelled'
        && event.kind !== 'websocket_reconnected'
      ) {
        markSessionAttention(eventSessionId);
      }

      if (event.kind !== 'session_upserted') {
        return;
      }

      const upsert = event as SessionUpsertedEvent;
      if (!upsert.sessionId || !upsert.session) {
        return;
      }
      projectOwnerRef.current?.invalidate('root');

      // The transcript of the currently viewed session changed on disk while
      // no run is active here (e.g. edited from another client or the CLI):
      // signal the chat view to reload its messages.
      const currentSelectedSession = selectedSessionRef.current;
      const incomingRevision = sessionHistoryRevision(upsert.session);
      if (shouldSignalExternalHistoryRefresh({
        viewedSessionId: currentSelectedSession?.id ?? null,
        eventSessionId: upsert.sessionId,
        active: activeSessionsRef.current.has(upsert.sessionId),
        currentRevision: sessionHistoryRevision(currentSelectedSession),
        incomingRevision,
        lastSignaledRevision: lastExternalHistoryRevisionRef.current.get(upsert.sessionId) ?? null,
      })) {
        if (incomingRevision) lastExternalHistoryRevisionRef.current.set(upsert.sessionId, incomingRevision);
        setExternalMessageUpdate((prev) => prev + 1);
      } else if (upsert.sessionId !== currentSelectedSession?.id) {
        markSessionAttention(upsert.sessionId);
      }

      setProjects((previousProjects) => {
        const targetProjectId = upsert.project?.projectId;
        const existingProject = previousProjects.find((project) =>
          targetProjectId ? project.projectId === targetProjectId : getProjectSessions(project).some((session) => session.id === upsert.sessionId),
        );

        if (!existingProject) {
          // First session of a project this client has never seen: create the
          // project entry from the event payload.
          if (!upsert.project) {
            return previousProjects;
          }

          const newProject: Project = {
            projectId: upsert.project.projectId,
            path: upsert.project.path,
            fullPath: upsert.project.fullPath,
            displayName: upsert.project.displayName,
            isStarred: upsert.project.isStarred,
            sessions: [],
            sessionMeta: { hasMore: false, total: 0, rootTotal: 0, rootOffset: 0, nextOffset: 0 },
          } as Project;

          return [...previousProjects, upsertSessionIntoProject(newProject, upsert)];
        }

        const updatedProject = upsertSessionIntoProject(existingProject, upsert);
        if (updatedProject === existingProject) {
          return previousProjects;
        }

        return previousProjects.map((project) =>
          project.projectId === existingProject.projectId ? updatedProject : project,
        );
      });

      // Keep the selected project reference in sync with the upsert.
      setSelectedProject((previousProject) => {
        if (!previousProject) {
          return previousProject;
        }
        const matches = upsert.project
          ? previousProject.projectId === upsert.project.projectId
          : getProjectSessions(previousProject).some((session) => session.id === upsert.sessionId);
        if (!matches) {
          return previousProject;
        }
        const updated = upsertSessionIntoProject(previousProject, upsert);
        return updated === previousProject ? previousProject : updated;
      });

      // Keep the selected row's canonical timestamp in sync. Without this,
      // duplicate watcher frames all compare against the revision from the
      // original project load and repeatedly refetch the same transcript.
      setSelectedSession((previousSession) => {
        if (!previousSession || previousSession.id !== upsert.sessionId) return previousSession;
        const updated: ProjectSession = {
          ...previousSession,
          ...upsert.session,
          id: upsert.sessionId,
          __provider: upsert.provider,
        };
        if (!upsert.session.summary?.trim() && previousSession.summary?.trim()) {
          updated.summary = previousSession.summary;
        }
        return JSON.stringify(updated) === JSON.stringify(previousSession) ? previousSession : updated;
      });

      // Realtime payloads carry only canonical app ids, so there is no native
      // provider-id alias to hand off to the selected session.
    };

    return subscribe(handleEvent);
  }, [markSessionAttention, navigate, sessionId, subscribe]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    clearSessionAttention(selectedSession?.id ?? sessionId ?? null);
  }, [clearSessionAttention, selectedSession?.id, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      // Route state is authoritative here. A New Session click clears the
      // selection and navigates home in the same React batch; the previous
      // session-route effect can briefly restore that selection before the
      // router commits `/`. Clear it again once the root route is observed.
      setSelectedSession((previousSession) => previousSession === null ? previousSession : null);
      return;
    }

    // Project membership is resolved through `projectId` after the migration.
    for (const project of projects) {
      const match = project.sessions?.find((session) => session.id === sessionId);
      if (match) {
        const normalizedSession = normalizeSessionProvider(match);
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== normalizedSession.__provider;

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession(normalizedSession);
        }
        return;
      }
    }

    if (selectedSession?.id === sessionId) {
      return;
    }

    // Session id is in the URL but not present on any loaded project payload.
    // The payloads are paginated (only each project's first session page is
    // loaded), so this is normal for deep links to older sessions. Never guess
    // the owning project from local state — that used to bind the session to
    // whatever project happened to be selected. Ask the backend instead; one
    // lookup per URL id.
    if (sessionLookupRef.current === sessionId) {
      return;
    }
    sessionLookupRef.current = sessionId;

    void (async () => {
      let details: SessionDetailsApiPayload['data'] | null = null;
      try {
        const response = await api.sessionDetails(sessionId);
        if (response.ok) {
          const payload = (await response.json()) as SessionDetailsApiPayload;
          details = payload.data ?? null;
        }
      } catch (error) {
        console.error(`Error resolving session ${sessionId}:`, error);
      }

      // The user navigated elsewhere while the lookup was in flight.
      if (sessionIdRef.current !== sessionId) {
        return;
      }

      if (!details) {
        // Unknown session id (or lookup failed). Fall back to the legacy
        // behavior: host a placeholder under the currently selected project so
        // chat state stays alive (without a `selectedSession`, chat clears
        // `currentSessionId` and stops reading the session store).
        const fallbackProject = selectedProjectRef.current;
        if (!fallbackProject || selectedSessionRef.current?.id === sessionId) {
          return;
        }

        setSelectedSession({
          id: sessionId,
          __provider: readSelectedProvider(),
          __projectId: fallbackProject.projectId,
          summary: '',
        });
        return;
      }

      // The URL carried a provider-native alias id: swap it for the canonical
      // app-facing id and let this effect re-run against the new URL.
      if (typeof details.sessionId === 'string' && details.sessionId && details.sessionId !== sessionId) {
        navigate(`/session/${details.sessionId}`, { replace: true });
        return;
      }

      const resolvedProjectId = details.project?.projectId;
      if (resolvedProjectId) {
        setSelectedProject((previousProject) => {
          if (previousProject?.projectId === resolvedProjectId) {
            return previousProject;
          }

          const loadedProject = projectsRef.current.find(
            (candidate) => candidate.projectId === resolvedProjectId,
          );
          if (loadedProject) {
            return loadedProject;
          }

          // Owning project is not in the active project list (e.g. archived):
          // synthesize a minimal entry so the chat view still gets its paths.
          return {
            projectId: resolvedProjectId,
            path: details.project?.path ?? details.project?.fullPath ?? '',
            fullPath: details.project?.fullPath ?? details.project?.path ?? '',
            displayName: details.project?.displayName ?? '',
            isStarred: Boolean(details.project?.isStarred),
            sessions: [],
            sessionMeta: { hasMore: false, total: 0, rootTotal: 0, rootOffset: 0, nextOffset: 0 },
          };
        });
      }

      const resolvedSession: ProjectSession = {
        id: sessionId,
        parentSessionId: details.parentSessionId ?? null,
        model: details.model ?? null,
        agent: details.agent ?? null,
        summary: details.summary ?? '',
        createdAt: details.createdAt ?? undefined,
        lastActivity: details.lastActivity ?? undefined,
        __provider:
          typeof details.provider === 'string' && details.provider.trim()
            ? (details.provider as LLMProvider)
            : readSelectedProvider(),
        __projectId: resolvedProjectId,
      };

      setSelectedSession((previousSession) =>
        previousSession?.id === sessionId
          ? { ...previousSession, ...resolvedSession }
          : resolvedSession,
      );
    })();
  }, [navigate, sessionId, projects, selectedProject, selectedSession?.id, selectedSession?.__provider]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession, project?: Project) => {
      if (!project) {
        clearSessionAttention(session.id);
        setSelectedSession(session);
        if (activeTab === 'browser') setActiveTab('chat');
        navigate(`/session/${session.id}`);
        return;
      }
      const selectedSessionWithProject = { ...session, __projectId: project.projectId };
      applySessionSelectionIntent(project, selectedSessionWithProject, {
        clearAttention: clearSessionAttention,
        selectProject: setSelectedProject,
        selectSession: setSelectedSession,
        showChat: activeTab === 'browser'
          ? () => setActiveTab('chat')
          : undefined,
        navigateToSession: (selectedSessionId) => navigate(`/session/${selectedSessionId}`),
        closeSidebar: isMobile && project.projectId !== selectedProject?.projectId
          ? () => setSidebarOpen(false)
          : undefined,
      });
    },
    [activeTab, clearSessionAttention, isMobile, navigate, selectedProject?.projectId],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      applyNewSessionIntent(project, {
        selectProject: setSelectedProject,
        clearSession: () => setSelectedSession(null),
        showChat: () => setActiveTab('chat'),
        triggerReset: () => setNewSessionTrigger((previous) => previous + 1),
        navigateToDraft: (selectedProject) => navigate(getProjectDraftUrl(selectedProject.projectId)),
        closeSidebar: isMobile ? () => setSidebarOpen(false) : undefined,
      });
    },
    [isMobile, navigate],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      clearSessionAttention(sessionIdToDelete);

      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) =>
        prevProjects.map((project) => removeSessionFromProject(project, sessionIdToDelete)),
      );
    },
    [clearSessionAttention, navigate, selectedSession?.id],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      projectOwnerRef.current?.invalidate('root');
      const freshProjects = await projectOwnerRef.current!.read('root', { force: true });
      const mergedProjects = mergeExpandedSessionPages(projects, freshProjects);

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, mergedProjects) ? mergedProjects : prevProjects,
      );

      if (!selectedProject) {
        return;
      }

      const refreshedProject = mergedProjects.find((project) => project.projectId === selectedProject.projectId);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === selectedSession.id,
      );

      if (refreshedSession) {
        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        const normalizedRefreshedSession =
          refreshedSession.__provider || !selectedSession.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: selectedSession.__provider };

        if (serialize(normalizedRefreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [projects, selectedProject, selectedSession]);

  const loadMoreProjectSessions = useCallback(async (projectId: string) => {
    const project = projects.find((candidate) => candidate.projectId === projectId);
    if (!project) {
      return;
    }

    const totalCount = Number(project.sessionMeta?.total ?? 0);
    if (project.sessionMeta?.hasMore === false || (totalCount === 0 && project.sessionMeta?.nextOffset === 0)) {
      return;
    }

    const rootOffset = Number(project.sessionMeta?.nextOffset ?? project.sessionMeta?.rootOffset ?? 0);

    const response = await api.projectSessions(projectId, {
      limit: 20,
      offset: rootOffset,
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string | { message?: string } };
      const errorPayload = payload.error;
      const message =
        typeof errorPayload === 'string'
          ? errorPayload
          : errorPayload && typeof errorPayload === 'object' && errorPayload.message
            ? errorPayload.message
            : `Failed to load more sessions for project ${projectId}`;
      throw new Error(message);
    }

    const sessionsPage = (await response.json()) as ProjectSessionPage;

    let mergedProjectForSelection: Project | null = null;
    setProjects((previousProjects) =>
      previousProjects.map((candidate) => {
        if (candidate.projectId !== projectId) {
          return candidate;
        }

        const mergedProject = mergeProjectSessionPage(candidate, sessionsPage);
        mergedProjectForSelection = mergedProject;
        return mergedProject;
      }),
    );

    if (selectedProject?.projectId === projectId && mergedProjectForSelection) {
      setSelectedProject(mergedProjectForSelection);
    }
  }, [projects, selectedProject?.projectId]);

  // `projectId` is the DB identifier passed from the sidebar's delete flow
  // after the migration away from folder-derived project names.
  const handleProjectDelete = useCallback(
    (projectId: string) => {
      if (selectedProject?.projectId === projectId) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) => prevProjects.filter((project) => project.projectId !== projectId));
    },
    [navigate, selectedProject?.projectId],
  );

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      activeSessions,
      attentionSessionIds,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onLoadMoreSessions: loadMoreProjectSessions,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      attentionSessionIds,
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      loadMoreProjectSessions,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      activeSessions,
      projects,
      settingsInitialTab,
      selectedProject,
      selectedSession,
      showSettings,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    loadMoreProjectSessions,
    handleProjectDelete,
    handleSidebarRefresh,
  };
}
