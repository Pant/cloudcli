import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type SessionSummary = {
  id: string;
  /** Canonical app id, null for roots, or omitted while the native parent is unresolved. */
  parentSessionId?: string | null;
  provider: string;
  model: string | null;
  agent: string | null;
  summary: string;
  messageCount: number;
  lastActivity: string;
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  model?: string | null;
  agent?: string | null;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
    rootTotal: number;
    rootOffset: number;
    nextOffset: number;
  };
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  synchronize?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
  rootTotal: number;
  rootOffset: number;
  nextOffset: number;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
    rootTotal: number;
    rootOffset: number;
    nextOffset: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;

/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

function mapSessionRowToSummary(
  row: SessionRepositoryRow,
  canonicalParentSessionId?: string | null,
): SessionSummary {
  const summary: SessionSummary = {
    id: row.session_id,
    provider: row.provider,
    model: row.model?.trim() || null,
    agent: row.agent?.trim() || null,
    summary: row.custom_name || '',
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
  };

  if (canonicalParentSessionId !== undefined) {
    summary.parentSessionId = canonicalParentSessionId;
  }

  return summary;
}

function readProjectSessionsIncludingArchived(projectPath: string): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];
  const parentResolutions = sessionsDb.getSessionParentResolutions(rows.map((row) => row.session_id));
  const rowIds = new Set(rows.map((row) => row.session_id));

  return {
    sessions: rows.map((row) => {
      const resolution = parentResolutions.get(row.session_id);
      const parentId = resolution?.parentSessionId;
      return mapSessionRowToSummary(
        row,
        resolution?.kind === 'resolved' && rowIds.has(parentId ?? '')
          ? parentId
          : resolution?.kind === 'root'
            ? null
            : undefined,
      );
    }),
    total: rows.length,
    hasMore: false,
    rootTotal: rows.length,
    rootOffset: 0,
    nextOffset: rows.length,
  };
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): ProjectSessionsPageResult {
  const pagination = normalizeSessionPagination(options);
  const page = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  );
  const rows = page.rows as SessionRepositoryRow[];
  const parentResolutions = sessionsDb.getSessionParentResolutions(rows.map((row) => row.session_id));
  const rowIds = new Set(rows.map((row) => row.session_id));

  return {
    sessions: rows.map((row) => {
      const resolution = parentResolutions.get(row.session_id);
      const parentId = resolution?.parentSessionId;
      return mapSessionRowToSummary(
        row,
        resolution?.kind === 'resolved' && rowIds.has(parentId ?? '')
          ? parentId
          : resolution?.kind === 'root'
            ? null
            : undefined,
      );
    }),
    total: page.total,
    hasMore: page.hasMore,
    rootTotal: page.rootTotal,
    rootOffset: page.rootOffset,
    nextOffset: page.nextOffset,
  };
}

// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame.
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    kind: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Reads all projects from DB and returns normalized session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (options.synchronize) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;
  const totalProjects = projectRows.length;
  const projects = await Promise.all(projectRows.map(async (row, index): Promise<ProjectListItem> => {
    const projectId = row.project_id;
    const projectPath = row.project_path;

    broadcastProgress({
      phase: 'loading',
      current: index + 1,
      total: totalProjects,
      currentProject: projectPath,
    });

    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);

    const sessionsPage = readProjectSessionsPageByPath(projectPath, {
      limit: options.sessionsLimit,
      offset: options.sessionsOffset,
    });

    return {
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
        rootTotal: sessionsPage.rootTotal,
        rootOffset: sessionsPage.rootOffset,
        nextOffset: sessionsPage.nextOffset,
      },
    };
  }));

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  });

  return projects;
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'synchronize'> = {},
): Promise<ArchivedProjectListItem[]> {
  if (options.synchronize) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getArchivedProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;

  const archivedProjects: ArchivedProjectListItem[] = [];

  for (const row of projectRows) {
    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);

    const sessionsPage = readProjectSessionsIncludingArchived(row.project_path);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      isArchived: true,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
        rootTotal: sessionsPage.rootTotal,
        rootOffset: sessionsPage.rootOffset,
        nextOffset: sessionsPage.nextOffset,
      },
    });
  }

  return archivedProjects;
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
      rootTotal: sessionsPage.rootTotal,
      rootOffset: sessionsPage.rootOffset,
      nextOffset: sessionsPage.nextOffset,
    },
  };
}
