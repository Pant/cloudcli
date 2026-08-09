import type {
  Project,
  ProjectSession,
  ProjectSessionMeta,
  RunningSessionAncestorSnapshot,
  RunningSessionSnapshot,
} from '../types/app';

import type { SessionActivity, SessionActivityMap } from './useSessionProtection';

export type SessionUpsert = {
  sessionId: string;
  provider?: ProjectSession['provider'];
  session: ProjectSession;
  project?: {
    projectId: string;
    path?: string;
    fullPath?: string;
    displayName?: string;
    isStarred?: boolean;
  } | null;
};

export function sessionHistoryRevision(session: ProjectSession | null | undefined): string | null {
  const revision = session?.lastActivity ?? session?.updated_at ?? session?.createdAt ?? session?.created_at;
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}

export function shouldSignalExternalHistoryRefresh(args: {
  viewedSessionId: string | null;
  eventSessionId: string;
  active: boolean;
  currentRevision: string | null;
  incomingRevision: string | null;
  lastSignaledRevision: string | null;
}): boolean {
  if (args.viewedSessionId !== args.eventSessionId || args.active) return false;
  if (args.incomingRevision === null) return true;
  return args.incomingRevision !== args.currentRevision
    && args.incomingRevision !== args.lastSignaledRevision;
}

const serialize = (value: unknown) => JSON.stringify(value ?? null);

export const getProjectSessions = (project: Project): ProjectSession[] => project.sessions ?? [];

export const mergeSessionProviderLists = (
  baseSessions: ProjectSession[],
  additionalSessions: ProjectSession[],
): ProjectSession[] => {
  const merged = [...baseSessions];
  const indexById = new Map(baseSessions.map((session, index) => [String(session.id), index]));

  for (const session of additionalSessions) {
    const id = String(session.id);
    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, merged.length);
      merged.push(session);
      continue;
    }
    const previous = merged[existingIndex];
    merged[existingIndex] = {
      ...previous,
      ...session,
      parentSessionId: session.parentSessionId !== undefined
        ? session.parentSessionId
        : previous.parentSessionId,
    };
  }
  return merged;
};

const mergeSessionMeta = (existing: ProjectSessionMeta | undefined, incoming: ProjectSessionMeta | undefined, loadedCount: number): ProjectSessionMeta => ({
  ...existing,
  ...incoming,
  total: Number(incoming?.total ?? existing?.total ?? loadedCount),
  hasMore: incoming?.hasMore ?? existing?.hasMore ?? false,
});

export const mergeExpandedSessionPages = (previousProjects: Project[], incomingProjects: Project[]): Project[] => {
  const previousById = new Map(previousProjects.map((project) => [project.projectId, project]));
  return incomingProjects.map((incoming) => {
    const previous = previousById.get(incoming.projectId);
    if (!previous) {
      return incoming;
    }
    const sessions = mergeSessionProviderLists(incoming.sessions ?? [], previous.sessions ?? []);
    const previousMeta = previous.sessionMeta;
    const incomingMeta = incoming.sessionMeta;
    const nextOffset = Math.max(
      Number(previousMeta?.nextOffset ?? previousMeta?.rootOffset ?? 0),
      Number(incomingMeta?.nextOffset ?? incomingMeta?.rootOffset ?? 0),
    );
    const rootOffset = Math.max(
      Number(previousMeta?.rootOffset ?? 0),
      Number(incomingMeta?.rootOffset ?? 0),
    );
    return {
      ...incoming,
      sessions,
      sessionMeta: {
        ...mergeSessionMeta(previousMeta, incomingMeta, sessions.length),
        rootOffset,
        nextOffset,
        hasMore: Boolean(incomingMeta?.hasMore || previousMeta?.hasMore),
      },
    };
  });
};

export const mergeProjectSessionPage = (existingProject: Project, page: Pick<Project, 'sessions' | 'sessionMeta'>): Project => {
  const sessions = mergeSessionProviderLists(existingProject.sessions ?? [], page.sessions ?? []);
  return {
    ...existingProject,
    sessions,
    // The page metadata is authoritative, especially `nextOffset`; never
    // derive a root offset from the number of loaded descendant rows.
    sessionMeta: mergeSessionMeta(existingProject.sessionMeta, page.sessionMeta, sessions.length),
  };
};

export const upsertSessionIntoProject = (project: Project, event: SessionUpsert): Project => {
  const normalized: ProjectSession = {
    ...event.session,
    id: event.sessionId,
    ...(event.provider ? { __provider: event.provider } : {}),
  };
  const sessions = project.sessions ?? [];
  const index = sessions.findIndex((session) => String(session.id) === event.sessionId);

  if (index < 0) {
    const next = { ...project, sessions: [normalized, ...sessions] };
    const currentTotal = Number(project.sessionMeta?.total ?? sessions.length);
    const hasRootPagination = project.sessionMeta?.rootTotal !== undefined || project.sessionMeta?.nextOffset !== undefined;
    // Only an explicit `null` is an authoritative root. An omitted parent is
    // unresolved and must not inflate the root total until a later event
    // resolves it (or explicitly marks it as a root).
    const isRoot = normalized.parentSessionId === null;
    next.sessionMeta = {
      ...project.sessionMeta,
      total: currentTotal + 1,
      hasMore: hasRootPagination ? project.sessionMeta?.hasMore ?? false : sessions.length + 1 < currentTotal + 1,
      ...(project.sessionMeta?.rootTotal !== undefined
        ? { rootTotal: Number(project.sessionMeta.rootTotal) + (isRoot ? 1 : 0) }
        : {}),
    };
    return next;
  }

  const current = sessions[index];
  const updated = {
    ...current,
    ...normalized,
    parentSessionId: normalized.parentSessionId !== undefined
      ? normalized.parentSessionId
      : current.parentSessionId,
  };
  if (!normalized.summary?.trim() && current.summary?.trim()) {
    updated.summary = current.summary;
  }
  if (serialize(current) === serialize(updated)) {
    return project;
  }
  const nextSessions = [...sessions];
  nextSessions[index] = updated;
  const wasRoot = current.parentSessionId === null;
  const isRoot = updated.parentSessionId === null;
  return {
    ...project,
    sessions: nextSessions,
    sessionMeta: project.sessionMeta?.rootTotal === undefined
      ? project.sessionMeta
      : {
        ...project.sessionMeta,
        rootTotal: Number(project.sessionMeta.rootTotal) + Number(isRoot) - Number(wasRoot),
      },
  };
};

const upsertHydratedSessionIntoProject = (project: Project, event: SessionUpsert): Project => {
  const sessions = project.sessions ?? [];
  const index = sessions.findIndex((session) => String(session.id) === event.sessionId);
  const normalized: ProjectSession = {
    ...event.session,
    id: event.sessionId,
    ...(event.provider ? { __provider: event.provider } : {}),
  };
  if (index < 0) {
    return {
      ...project,
      sessions: [normalized, ...sessions],
      sessionMeta: project.sessionMeta?.rootTotal === undefined
        ? project.sessionMeta
        : {
          ...project.sessionMeta,
          rootTotal: Number(project.sessionMeta.rootTotal) + (normalized.parentSessionId === null ? 1 : 0),
        },
    };
  }
  const updated = {
    ...sessions[index],
    ...normalized,
    parentSessionId: normalized.parentSessionId !== undefined
      ? normalized.parentSessionId
      : sessions[index].parentSessionId,
  };
  if (!normalized.summary?.trim() && sessions[index].summary?.trim()) {
    updated.summary = sessions[index].summary;
  }
  if (serialize(updated) === serialize(sessions[index])) {
    return project;
  }
  const nextSessions = [...sessions];
  nextSessions[index] = updated;
  const wasRoot = sessions[index].parentSessionId === null;
  const isRoot = updated.parentSessionId === null;
  return {
    ...project,
    sessions: nextSessions,
    sessionMeta: project.sessionMeta?.rootTotal === undefined || wasRoot === isRoot
      ? project.sessionMeta
      : {
        ...project.sessionMeta,
        rootTotal: Number(project.sessionMeta.rootTotal) + Number(isRoot) - Number(wasRoot),
      },
  };
};

const projectFromSnapshot = (snapshot: SessionActivity | RunningSessionSnapshot): Project | null => {
  const project = snapshot.project;
  if (!project?.projectId) {
    return null;
  }
  return {
    projectId: project.projectId,
    path: project.path ?? project.fullPath ?? '',
    fullPath: project.fullPath ?? project.path ?? '',
    displayName: project.displayName ?? project.projectId,
    isStarred: Boolean(project.isStarred),
    sessions: [],
    sessionMeta: {
      total: 1,
      hasMore: false,
      rootTotal: snapshot.parentSessionId === null ? 1 : 0,
      rootOffset: 0,
      nextOffset: 0,
    },
  };
};

const sessionFromSnapshot = (snapshot: SessionActivity | RunningSessionSnapshot, sessionId: string): ProjectSession | null => {
  if (!snapshot.session) {
    return null;
  }
  const session = snapshot.session as ProjectSession;
  return {
    ...session,
    id: session.id || sessionId,
    parentSessionId: snapshot.parentSessionId !== undefined
      ? snapshot.parentSessionId
      : session.parentSessionId,
    provider: session.provider ?? snapshot.provider,
    __provider: session.__provider ?? snapshot.provider,
    __projectId: snapshot.project?.projectId ?? session.__projectId,
  };
};

const projectFromAncestor = (ancestor: RunningSessionAncestorSnapshot): Project | null => {
  const project = ancestor.project;
  if (!project?.projectId) {
    return null;
  }
  return {
    projectId: project.projectId,
    path: project.path ?? project.fullPath ?? '',
    fullPath: project.fullPath ?? project.path ?? '',
    displayName: project.displayName ?? project.projectId,
    isStarred: Boolean(project.isStarred),
    sessions: [],
    sessionMeta: { total: 0, hasMore: false, rootTotal: 0, rootOffset: 0, nextOffset: 0 },
  };
};

const sessionFromAncestor = (ancestor: RunningSessionAncestorSnapshot): ProjectSession | null => {
  if (!ancestor.session || !ancestor.sessionId) {
    return null;
  }
  return {
    ...ancestor.session,
    id: ancestor.session.id || ancestor.sessionId,
    parentSessionId: ancestor.parentSessionId !== undefined
      ? ancestor.parentSessionId
      : ancestor.session.parentSessionId,
    provider: ancestor.session.provider ?? ancestor.provider,
    __provider: ancestor.session.__provider ?? ancestor.provider,
    __projectId: ancestor.project?.projectId ?? ancestor.session.__projectId,
  };
};

/** Merge inactive running context without changing exact-session pagination totals. */
const upsertRunningAncestorIntoProject = (project: Project, ancestor: RunningSessionAncestorSnapshot): Project => {
  const session = sessionFromAncestor(ancestor);
  if (!session) {
    return project;
  }

  const sessions = project.sessions ?? [];
  const index = sessions.findIndex((candidate) => String(candidate.id) === ancestor.sessionId);
  if (index < 0) {
    return { ...project, sessions: [...sessions, session] };
  }

  const current = sessions[index];
  const updated = {
    ...current,
    ...session,
    parentSessionId: session.parentSessionId !== undefined
      ? session.parentSessionId
      : current.parentSessionId,
  };
  if (!updated.summary?.trim() && current.summary?.trim()) {
    updated.summary = current.summary;
  }
  if (serialize(current) === serialize(updated)) {
    return project;
  }
  const nextSessions = [...sessions];
  nextSessions[index] = updated;
  return { ...project, sessions: nextSessions };
};

const mergeRunningAncestorContext = (
  projects: Project[],
  ancestors: readonly RunningSessionAncestorSnapshot[],
): Project[] => {
  let nextProjects = projects;
  for (const ancestor of ancestors) {
    const ancestorProject = projectFromAncestor(ancestor);
    if (!ancestorProject) {
      continue;
    }

    const target = nextProjects.find((project) => project.projectId === ancestorProject.projectId);
    if (!target) {
      nextProjects = [...nextProjects, upsertRunningAncestorIntoProject(ancestorProject, ancestor)];
      continue;
    }

    const updated = upsertRunningAncestorIntoProject(target, ancestor);
    if (updated !== target) {
      nextProjects = nextProjects.map((project) => project.projectId === target.projectId ? updated : project);
    }
  }
  return nextProjects;
};

/** Merge enriched running rows without advancing root pagination cursors. */
export const mergeRunningSnapshotsIntoProjects = (
  projects: Project[],
  activity: SessionActivityMap | ReadonlyMap<string, SessionActivity | RunningSessionSnapshot>,
): Project[] => {
  let nextProjects = projects;
  for (const [sessionId, snapshot] of activity) {
    const ancestors = 'ancestors' in snapshot && Array.isArray(snapshot.ancestors)
      ? snapshot.ancestors
      : [];

    const session = sessionFromSnapshot(snapshot, sessionId);
    const projectData = projectFromSnapshot(snapshot);
    if (!session || !projectData) {
      nextProjects = mergeRunningAncestorContext(nextProjects, ancestors);
      continue;
    }

    // A canonical session must occur in one project only. Remove a stale copy
    // before inserting the snapshot's authoritative project membership.
    nextProjects = nextProjects.map((project) => {
      if (project.projectId === projectData.projectId) {
        return project;
      }
      if (!(project.sessions ?? []).some((candidate) => String(candidate.id) === sessionId)) {
        return project;
      }
      const retained = (project.sessions ?? []).filter((candidate) => String(candidate.id) !== sessionId);
      const removedSession = (project.sessions ?? []).find((candidate) => String(candidate.id) === sessionId);
      return {
        ...project,
        sessions: retained,
        sessionMeta: {
          ...project.sessionMeta,
          total: Math.max(0, Number(project.sessionMeta?.total ?? retained.length) - 1),
          ...(project.sessionMeta?.rootTotal !== undefined && removedSession
            ? { rootTotal: Math.max(0, Number(project.sessionMeta.rootTotal) - (removedSession.parentSessionId === null ? 1 : 0)) }
            : {}),
        },
      };
    });

    const target = nextProjects.find((project) => project.projectId === projectData.projectId);
    if (!target) {
      nextProjects = [...nextProjects, upsertHydratedSessionIntoProject(projectData, {
        sessionId,
        provider: snapshot.provider,
        session,
        project: projectData,
      })];
      nextProjects = mergeRunningAncestorContext(nextProjects, ancestors);
      continue;
    }

    const updated = upsertHydratedSessionIntoProject(target, {
      sessionId,
      provider: snapshot.provider,
      session,
      project: projectData,
    });
    if (updated !== target) {
      nextProjects = nextProjects.map((project) => project.projectId === target.projectId ? updated : project);
    }
    nextProjects = mergeRunningAncestorContext(nextProjects, ancestors);
  }
  return nextProjects;
};

export const mergeRunningSessionSnapshot = (
  projects: Project[],
  snapshot: RunningSessionSnapshot,
): Project[] => mergeRunningSnapshotsIntoProjects(projects, new Map([[snapshot.sessionId, snapshot]]));
