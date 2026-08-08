import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionRunStateDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import {
  listOpenCodeChildActivitySnapshots,
  listOpenCodeRunningChildSessions,
} from '@/modules/providers/list/opencode/opencode-activity-inspector.provider.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
  SessionLifecycleContext,
  SessionLifecycleSnapshot,
  SessionLifecycleStatus,
  SessionRunStateRecord,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
};

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  /** Canonical app id, null for roots, or omitted while the native parent is unresolved. */
  parentSessionId?: string | null;
  isProjectArchived: boolean;
};

type SessionDetails = {
  /** Canonical app-facing session id (may differ from the looked-up id when a provider-native id was given). */
  sessionId: string;
  provider: LLMProvider;
  /** Model recorded for this session, or null until its first configured run. */
  model: string | null;
  /** OpenCode agent recorded for this session, or null for other providers/new sessions. */
  agent: string | null;
  summary: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  /** Canonical app id, null for roots, or omitted while the native parent is unresolved. */
  parentSessionId?: string | null;
  isArchived: boolean;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    isArchived: boolean;
  } | null;
};

/**
 * Enriched active-session snapshot returned by the provider running endpoint.
 *
 * `sessionId` and `parentSessionId` are always CloudCLI app ids. Provider-native
 * ids are used only during the OpenCode activity lookup and never cross the API
 * boundary. `session` and `project` are nullable for legacy registry entries
 * whose database row has not been indexed yet.
 */
export type RunningSession = {
  sessionId: string;
  provider: LLMProvider;
  startedAt: number;
  lastSeq: number;
  status: 'running';
  statusText: string | null;
  canInterrupt: boolean;
  parentSessionId?: string | null;
  session: {
    id: string;
    provider: LLMProvider;
    model: string | null;
    agent: string | null;
    summary: string;
    messageCount: number;
    lastActivity: string;
  } | null;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
  } | null;
  /**
   * Inactive canonical ancestors needed to render an off-page running child.
   * These are context rows, not running entries: they are deliberately not
   * included in the running-session list and cannot be interrupted.
   */
  ancestors?: RunningSessionAncestor[];
};

/**
 * App-facing summary for an inactive OpenCode ancestor of a running session.
 * Only canonical CloudCLI ids cross this boundary; provider-native ids remain
 * inside the sessions repository and provider activity inspector.
 */
export type RunningSessionAncestor = {
  sessionId: string;
  provider: LLMProvider;
  parentSessionId?: string | null;
  session: NonNullable<RunningSession['session']>;
  project: RunningSession['project'];
};

type IndexedSessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

function createRunningSessionDetails(row: IndexedSessionRow): Pick<RunningSession, 'parentSessionId' | 'session' | 'project'> {
  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const lastActivity = row.updated_at ?? row.created_at ?? new Date().toISOString();

  const details: Pick<RunningSession, 'parentSessionId' | 'session' | 'project'> = {
    session: {
      id: row.session_id,
      provider: row.provider as LLMProvider,
      model: row.model?.trim() || null,
      agent: row.agent?.trim() || null,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity,
    },
    project: project && projectPath
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName: resolveProjectDisplayName(project.project_path, project.custom_project_name),
        isStarred: Boolean(project.isStarred),
      }
      : null,
  };

  const parentResolution = sessionsDb.getSessionParentResolution(row.session_id);
  if (parentResolution.kind === 'root' || parentResolution.kind === 'resolved') {
    details.parentSessionId = parentResolution.parentSessionId;
  }

  return details;
}

const LIFECYCLE_STATUS_LIMIT = 200;
const DEFAULT_TASK_STALE_MS = 5 * 60 * 1000;

function lifecycleStaleMs(): number {
  const configured = Number(process.env.OPENCODE_SESSION_STALE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TASK_STALE_MS;
}

function createLifecycleContext(row: IndexedSessionRow): SessionLifecycleContext {
  const details = createRunningSessionDetails(row);
  return {
    sessionId: row.session_id,
    provider: row.provider as LLMProvider,
    ...(details.parentSessionId !== undefined ? { parentSessionId: details.parentSessionId } : {}),
    session: {
      id: row.session_id,
      provider: row.provider as LLMProvider,
      model: row.model?.trim() || null,
      agent: row.agent?.trim() || null,
      summary: row.custom_name || '',
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: details.project,
  };
}

function durableStatus(record: SessionRunStateRecord): SessionLifecycleStatus | null {
  return record.lifecycleState === 'completed' ? null : record.lifecycleState;
}

function isRestartable(status: SessionLifecycleStatus): boolean {
  return ['stalled', 'exited', 'failed', 'manually_stopped', 'recovery_exhausted'].includes(status);
}

function createLifecycleAncestors(sessionId: string, actionableIds: ReadonlySet<string>): SessionLifecycleContext[] {
  const ancestors: SessionLifecycleContext[] = [];
  const visited = new Set([sessionId]);
  let currentId = sessionId;
  while (true) {
    const resolution = sessionsDb.getSessionParentResolution(currentId);
    if (resolution.kind !== 'resolved' || !resolution.parentSessionId || visited.has(resolution.parentSessionId)) break;
    currentId = resolution.parentSessionId;
    visited.add(currentId);
    const row = sessionsDb.getSessionById(currentId);
    if (!row || row.provider !== 'opencode') break;
    if (!actionableIds.has(currentId)) ancestors.push(createLifecycleContext(row));
  }
  return ancestors;
}

function createRegistryRunningSession(run: ReturnType<typeof chatRunRegistry.listRunningRuns>[number]): RunningSession {
  const row = sessionsDb.getSessionById(run.sessionId);
  const details = row ? createRunningSessionDetails(row) : {
    session: null,
    project: null,
  };

  return {
    sessionId: run.sessionId,
    provider: run.provider,
    startedAt: run.startedAt,
    lastSeq: run.lastSeq,
    status: 'running',
    statusText: null,
    canInterrupt: true,
    ...details,
  };
}

function createNativeRunningSession(
  providerSessionId: string,
  activity: ReturnType<typeof listOpenCodeRunningChildSessions>[number],
): RunningSession | null {
  const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
  if (!row || row.provider !== 'opencode' || row.isArchived) {
    return null;
  }

  const details = createRunningSessionDetails(row);
  return {
    sessionId: row.session_id,
    provider: 'opencode',
    startedAt: activity.startedAt ?? (Date.parse(row.created_at) || Date.now()),
    lastSeq: 0,
    status: 'running',
    statusText: activity.statusText,
    canInterrupt: false,
    ...details,
  };
}

/**
 * Builds the bounded canonical parent closure for one exact running row.
 * Unknown parents and cycles terminate the walk so malformed provider data
 * cannot leak native ids or make the running endpoint recurse forever.
 */
function createRunningAncestorContext(
  runningSession: RunningSession,
  exactRunningIds: ReadonlySet<string>,
): RunningSessionAncestor[] {
  if (runningSession.provider !== 'opencode') {
    return [];
  }

  const ancestors: RunningSessionAncestor[] = [];
  const visited = new Set<string>([runningSession.sessionId]);
  let currentId: string | undefined = runningSession.sessionId;

  while (currentId) {
    const parentResolution = sessionsDb.getSessionParentResolution(currentId);
    if (parentResolution.kind !== 'resolved' || !parentResolution.parentSessionId) {
      break;
    }

    const parentId = parentResolution.parentSessionId;
    if (visited.has(parentId)) {
      break;
    }
    visited.add(parentId);

    const parentRow = sessionsDb.getSessionById(parentId);
    if (!parentRow || parentRow.provider !== 'opencode') {
      break;
    }

    if (!exactRunningIds.has(parentId)) {
      const details = createRunningSessionDetails(parentRow);
      if (details.session && details.project) {
        ancestors.push({
          sessionId: parentId,
          provider: 'opencode',
          ...(details.parentSessionId !== undefined ? { parentSessionId: details.parentSessionId } : {}),
          session: details.session,
          project: details.project,
        });
      }
    }

    currentId = parentId;
  }

  return ancestors;
}

/**
 * Metadata-only session row consumed by browser cache reconciliation through the
 * providers module barrel. `revision` is the persisted session update timestamp,
 * never a request-time value, so unchanged rows produce stable cache keys.
 */
export type ProviderSessionCacheManifestItem = {
  sessionId: string;
  provider: LLMProvider;
  revision: string;
  isArchived: boolean;
  historyReady: boolean;
};

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  listRunningSessions(): RunningSession[] {
    const registryRuns = chatRunRegistry.listRunningRuns();
    const runningBySessionId = new Map<string, RunningSession>();
    const runningOpenCodeRoots = new Set<string>();

    for (const run of registryRuns) {
      runningBySessionId.set(run.sessionId, createRegistryRunningSession(run));
      if (run.provider === 'opencode') {
        runningOpenCodeRoots.add(run.sessionId);
      }
    }

    if (runningOpenCodeRoots.size === 0) {
      return Array.from(runningBySessionId.values());
    }

    // Native activity is only an augmentation of an active CloudCLI OpenCode
    // run. This prevents an unrelated OpenCode process, or a stale indexed
    // child, from appearing in CloudCLI's processing map.
    const nativeCandidates = listOpenCodeRunningChildSessions();
    const nativeEntries = new Map<string, RunningSession>();

    for (const activity of nativeCandidates) {
      const entry = createNativeRunningSession(activity.providerSessionId, activity);
      if (!entry || runningBySessionId.has(entry.sessionId)) {
        continue;
      }
      nativeEntries.set(entry.sessionId, entry);
    }

    const ancestryContainsRunningRoot = (sessionId: string): boolean => {
      const visited = new Set<string>();
      let currentId: string | null | undefined = sessionId;
      while (currentId && !visited.has(currentId)) {
        if (runningOpenCodeRoots.has(currentId)) {
          return true;
        }
        visited.add(currentId);
        currentId = sessionsDb.getCanonicalParentSessionId(currentId);
      }
      return false;
    };

    // Repeatedly evaluate candidates so a grandchild can be retained after its
    // indexed immediate parent has been accepted in the same snapshot.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [sessionId, entry] of nativeEntries) {
        if (!runningBySessionId.has(sessionId) && ancestryContainsRunningRoot(sessionId)) {
          runningBySessionId.set(sessionId, entry);
          changed = true;
        }
      }
    }

    const exactRunningSessions = Array.from(runningBySessionId.values());
    const exactRunningIds = new Set(exactRunningSessions.map((session) => session.sessionId));
    const emittedAncestorIds = new Set<string>();
    return exactRunningSessions.map((session) => {
      const ancestors = createRunningAncestorContext(session, exactRunningIds)
        .filter((ancestor) => {
          if (emittedAncestorIds.has(ancestor.sessionId)) {
            return false;
          }
          emittedAncestorIds.add(ancestor.sessionId);
          return true;
        });
      return ancestors.length > 0 ? { ...session, ancestors } : session;
    });
  },

  /**
   * Builds bounded actionable lifecycle rows for provider routes and frontend polling.
   * Durable intent wins over stale provider rows, and native ids are resolved before serialization.
   */
  listSessionLifecycleStatus(now = Date.now()): SessionLifecycleSnapshot[] {
    const registryRuns = chatRunRegistry.listRunningRuns();
    const trackedIds = new Set(registryRuns.map((run) => run.sessionId));
    const durable = sessionRunStateDb.listActionable(LIFECYCLE_STATUS_LIMIT);
    const durableById = new Map(durable.map((record) => [record.sessionId, record]));
    const candidates = new Map<string, SessionLifecycleSnapshot>();

    const put = (
      row: IndexedSessionRow,
      status: SessionLifecycleStatus,
      options: { statusText?: string | null; lastActivityAt?: number; terminalReason?: SessionRunStateRecord['terminalReason']; exitCode?: number | null; signal?: NodeJS.Signals | null } = {},
    ): void => {
      if (row.isArchived) return;
      candidates.set(row.session_id, {
        ...createLifecycleContext(row),
        status,
        statusText: options.statusText ?? null,
        lastActivityAt: options.lastActivityAt ?? (Date.parse(row.updated_at ?? row.created_at) || now),
        restartable: isRestartable(status),
        canInterrupt: trackedIds.has(row.session_id) && status !== 'manually_stopped',
        terminalReason: options.terminalReason ?? null,
        exitCode: options.exitCode ?? null,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    };

    for (const run of registryRuns) {
      const row = sessionsDb.getSessionById(run.sessionId);
      if (!row) continue;
      const record = durableById.get(run.sessionId);
      const status = record?.lifecycleState === 'manually_stopped'
        ? 'manually_stopped'
        : record?.lifecycleState === 'recovering' ? 'recovering' : 'running';
      put(row, status, {
        lastActivityAt: Math.max(record?.lastProgressAt ?? 0, run.startedAt),
        terminalReason: record?.terminalReason,
        exitCode: record?.exitCode,
        statusText: record?.terminalMessage,
      });
    }

    for (const record of durable) {
      if (candidates.has(record.sessionId)) continue;
      const row = sessionsDb.getSessionById(record.sessionId);
      const status = durableStatus(record);
      if (!row || !status) continue;
      const latestHistory = sessionRunStateDb.listRecentHistory(1, record.sessionId)[0];
      put(row, status, {
        lastActivityAt: Math.max(record.lastProgressAt, record.updatedAt),
        terminalReason: record.terminalReason,
        exitCode: record.exitCode,
        signal: latestHistory?.generation === record.generation ? latestHistory.signal : null,
        statusText: record.terminalMessage,
      });
    }

    const ownerIsViable = (sessionId: string): boolean => {
      const visited = new Set<string>();
      let current: string | null | undefined = sessionId;
      while (current && !visited.has(current)) {
        visited.add(current);
        if (trackedIds.has(current)) return true;
        const state = durableById.get(current);
        if (state?.desiredState === 'running' && !['manually_stopped', 'recovery_exhausted'].includes(state.lifecycleState)) return true;
        current = sessionsDb.getCanonicalParentSessionId(current);
      }
      return false;
    };

    for (const activity of listOpenCodeChildActivitySnapshots()) {
      const row = sessionsDb.getSessionByProviderSessionId(activity.providerSessionId);
      if (!row || row.provider !== 'opencode' || candidates.has(row.session_id)) continue;
      if (activity.state === 'completed') continue;
      const lastActivityAt = activity.lastActivityAt ?? activity.startedAt ?? (Date.parse(row.updated_at) || now);
      let status: SessionLifecycleStatus;
      if (activity.state === 'error') status = 'failed';
      else if (activity.state === 'cancelled') status = 'exited';
      else if (now - lastActivityAt <= lifecycleStaleMs()) status = 'running';
      else status = ownerIsViable(row.session_id) ? 'stalled' : 'exited';
      put(row, status, { statusText: activity.statusText, lastActivityAt });
    }

    const ordered = Array.from(candidates.values())
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.sessionId.localeCompare(right.sessionId))
      .slice(0, LIFECYCLE_STATUS_LIMIT);
    const actionableIds = new Set(ordered.map((entry) => entry.sessionId));
    const emittedAncestors = new Set<string>();
    return ordered.map((entry) => {
      if (entry.provider !== 'opencode') return entry;
      const ancestors = createLifecycleAncestors(entry.sessionId, actionableIds).filter((ancestor) => {
        if (emittedAncestors.has(ancestor.sessionId)) return false;
        emittedAncestors.add(ancestor.sessionId);
        return true;
      });
      return ancestors.length > 0 ? { ...entry, ancestors } : entry;
    });
  },

  /**
   * Resolves the provider-native session id a runtime needs for resume.
   *
   * Callers hand provider runtimes the stable app session id; the provider
   * CLIs/SDKs only understand their own native id, which lives on the session
   * row. Ids without a row are assumed to be provider-native already (direct
   * API callers that reference sessions the watcher has not indexed yet).
   */
  resolveProviderSessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId) {
      return null;
    }

    const session = sessionsDb.getSessionById(sessionId);
    return session ? session.provider_session_id : sessionId;
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run.
   */
  createAppSession(provider: LLMProvider, projectPath: string): CreateAppSessionResult {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    const sessionId = randomUUID();
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath);

    return {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
    };
  },

  /**
   * Resolves the provider-native id only for an explicit user copy action.
   * Normal session payloads continue to expose only the stable app id.
   */
  getProviderSessionId(sessionId: string): string {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!session.provider_session_id) {
      throw new AppError('This session ID is not available yet.', {
        code: 'PROVIDER_SESSION_ID_NOT_AVAILABLE',
        statusCode: 409,
      });
    }

    return session.provider_session_id;
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const result = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath: session.project_path ?? '',
      providerSessionId: session.provider_session_id,
    });

    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        sessionId,
      })),
    };
  },

  /**
   * Resolves one session (by app id, falling back to the provider-native id)
   * to its metadata plus the owning project.
   *
   * This backs deep links like `/session/:sessionId`: the frontend's paginated
   * project payloads only carry each project's first session page, so a
   * session opened directly by URL may not be present client-side at all —
   * this lookup is the authoritative way to learn which project owns it.
   */
  getSessionDetailsById(sessionId: string): SessionDetails {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projectPath = session.project_path?.trim() ? session.project_path : null;
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;

    const details: SessionDetails = {
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      model: session.model?.trim() || null,
      agent: session.agent?.trim() || null,
      summary: session.custom_name?.trim() || '',
      createdAt: session.created_at ?? null,
      updatedAt: session.updated_at ?? null,
      lastActivity: session.updated_at ?? session.created_at ?? null,
      isArchived: Boolean(session.isArchived),
      project: project && projectPath
        ? {
            projectId: project.project_id,
            path: projectPath,
            fullPath: projectPath,
            displayName: resolveProjectDisplayName(projectPath, project.custom_project_name),
            isStarred: Boolean(project.isStarred),
            isArchived: Boolean(project.isArchived),
          }
        : null,
    };

    const parentResolution = sessionsDb.getSessionParentResolution(session.session_id);
    if (parentResolution.kind === 'root' || parentResolution.kind === 'resolved') {
      details.parentSessionId = parentResolution.parentSessionId;
    }

    return details;
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    const parentResolutions = sessionsDb.getSessionParentResolutions(
      archivedSessions.map((session) => session.session_id),
    );

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      const item: ArchivedSessionListItem = {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
      const parentResolution = parentResolutions.get(session.session_id);
      if (parentResolution?.kind === 'root' || parentResolution?.kind === 'resolved') {
        item.parentSessionId = parentResolution.parentSessionId;
      }
      return item;
    });
  },

  /**
   * Lists every indexed session for browser cache reconciliation without asking
   * any provider adapter to read transcript content.
   */
  listSessionCacheManifest(): ProviderSessionCacheManifestItem[] {
    return sessionsDb.getSessionManifestRows().map((session) => ({
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      revision: session.updated_at ?? session.created_at,
      isArchived: Boolean(session.isArchived),
      // App-created rows have no provider transcript until this mapping exists.
      historyReady: typeof session.provider_session_id === 'string'
        && session.provider_session_id.trim().length > 0,
    }));
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
