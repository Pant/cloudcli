import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import {
  getOpenCodeDatabasePath,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/**
 * One OpenCode child session identified by an active persisted Task tool part.
 *
 * The provider-native id is intentionally kept inside the provider module. The
 * sessions service must resolve it through the indexed sessions repository
 * before returning an app-facing running-session payload.
 */
export type OpenCodeActiveChildSession = {
  providerSessionId: string;
  startedAt: number | null;
  statusText: string | null;
};

/** Backend-only persisted Task lifecycle used for canonical child resolution and recovery health. */
export type OpenCodeChildActivitySnapshot = OpenCodeActiveChildSession & {
  state: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
  taskUpdatedAt: number | null;
  childActivityAt: number | null;
  lastActivityAt: number | null;
};

type PartRow = {
  data: unknown;
  time_created?: number | string | null;
  time_updated?: number | string | null;
};

type PartActivity = OpenCodeActiveChildSession & { state: string };
type SnapshotPartActivity = PartActivity & { taskUpdatedAt: number | null };

const ACTIVE_TOOL_STATUSES = new Set(['pending', 'running']);
const TASK_TOOL_NAMES = new Set(['task', 'subtask', 'subagent', 'sub-agent']);

// OpenCode has used both acronym-preserving and snake-case JSON field names in
// persisted tool metadata. Do not include generic `id` or `parent*` keys: those
// commonly identify the tool call or owning session, not the child session.
const CHILD_SESSION_KEYS = new Set([
  'sessionid',
  'childsessionid',
  'subagentsessionid',
  'tasksessionid',
  'childid',
  'taskid',
  'session_id',
  'child_session_id',
  'subagent_session_id',
  'task_session_id',
  'child_id',
  'task_id',
]);

function readNestedRecord(value: unknown): Record<string, unknown> | null {
  return readObjectRecord(value) ?? readJsonRecord(value);
}

function normalizeKey(key: string): string {
  return key.replace(/[-_]/g, '').toLowerCase();
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // A few old fixtures and OpenCode-adjacent writers use Unix seconds.
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return normalizeTimestamp(numeric);
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readActiveStatus(part: Record<string, unknown>): string | null {
  const state = readObjectRecord(part.state) ?? readObjectRecord(part.toolState);
  const status = readOptionalString(state?.status)
    ?? readOptionalString(state?.type)
    ?? readOptionalString(part.status);
  return status?.trim().toLowerCase() ?? null;
}

function isTaskPart(part: Record<string, unknown>): boolean {
  const nestedPart = readObjectRecord(part.part);
  const toolName = readOptionalString(part.tool)
    ?? readOptionalString(part.name)
    ?? readOptionalString(nestedPart?.tool)
    ?? readOptionalString(nestedPart?.name)
    ?? readOptionalString(part.type);

  if (!toolName) {
    return false;
  }

  return TASK_TOOL_NAMES.has(toolName.trim().toLowerCase().replace(/\s+/g, '-'));
}

function readChildSessionIds(value: unknown, depth = 0): string[] {
  if (depth > 5) {
    return [];
  }

  const record = readNestedRecord(value);
  if (!record) {
    return [];
  }

  const ids: string[] = [];
  for (const [key, childValue] of Object.entries(record)) {
    const normalizedKey = normalizeKey(key);
    const isCandidateKey = CHILD_SESSION_KEYS.has(key) || CHILD_SESSION_KEYS.has(normalizedKey);

    if (isCandidateKey) {
      const id = readOptionalString(childValue)?.trim();
      if (id) {
        ids.push(id);
      }
      continue;
    }

    // Metadata has appeared nested under state.metadata, data.metadata, and a
    // legacy metadata.metadata wrapper. Recurse only through objects; arrays
    // are not expected to carry a session binding and are intentionally ignored.
    if (readNestedRecord(childValue)) {
      ids.push(...readChildSessionIds(childValue, depth + 1));
    }
  }

  return ids;
}

function readStartedAt(
  part: Record<string, unknown>,
  row: PartRow,
): number | null {
  const state = readNestedRecord(part.state) ?? readNestedRecord(part.toolState);
  const stateTime = readNestedRecord(state?.time);
  const metadata = readNestedRecord(state?.metadata) ?? readNestedRecord(part.metadata);

  return normalizeTimestamp(stateTime?.start)
    ?? normalizeTimestamp(stateTime?.started)
    ?? normalizeTimestamp(state?.startedAt)
    ?? normalizeTimestamp(state?.started_at)
    ?? normalizeTimestamp(metadata?.startedAt)
    ?? normalizeTimestamp(metadata?.started_at)
    ?? normalizeTimestamp(part.startedAt)
    ?? normalizeTimestamp(part.started_at)
    ?? normalizeTimestamp(row.time_created);
}

function readStatusText(part: Record<string, unknown>): string | null {
  const state = readNestedRecord(part.state) ?? readNestedRecord(part.toolState);
  const metadata = readNestedRecord(state?.metadata) ?? readNestedRecord(part.metadata);
  return readOptionalString(state?.title)
    ?? readOptionalString(metadata?.title)
    ?? readOptionalString(metadata?.description)
    ?? readOptionalString(part.title)
    ?? null;
}

function inspectPart(
  row: PartRow,
): PartActivity[] {
  const part = readJsonRecord(row.data);
  if (!part || !isTaskPart(part)) {
    return [];
  }

  const status = readActiveStatus(part);
  if (!status) {
    return [];
  }

  const state = readNestedRecord(part.state) ?? readNestedRecord(part.toolState);
  const candidates = [
    state?.metadata,
    part.metadata,
    state?.input,
    part.input,
    state,
  ];
  const ids = new Set<string>();
  for (const candidate of candidates) {
    for (const id of readChildSessionIds(candidate)) {
      ids.add(id);
    }
  }

  return Array.from(ids, (providerSessionId) => ({
    providerSessionId,
    startedAt: readStartedAt(part, row),
    statusText: readStatusText(part),
    state: status,
  }));
}

function inspectSnapshotPart(row: PartRow): SnapshotPartActivity[] {
  const taskUpdatedAt = normalizeTimestamp(row.time_updated) ?? normalizeTimestamp(row.time_created);
  return inspectPart(row).map((activity) => ({ ...activity, taskUpdatedAt }));
}

function readLatestChildActivity(db: Database.Database, providerSessionId: string): number | null {
  let latest: number | null = null;
  const queries = [
    ['session', 'id', ['time_updated', 'time_created']],
    ['message', 'session_id', ['time_updated', 'time_created']],
    ['part', 'session_id', ['time_updated', 'time_created']],
  ] as const;
  for (const [table, idColumn, timeColumns] of queries) {
    try {
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has(idColumn)) continue;
      const available = timeColumns.filter((column) => columns.has(column));
      if (available.length === 0) continue;
      const expression = available.length === 2 ? `COALESCE(${available[0]}, ${available[1]})` : available[0];
      const row = db.prepare(`SELECT MAX(${expression}) AS activity FROM ${table} WHERE ${idColumn} = ?`).get(providerSessionId) as { activity?: unknown } | undefined;
      const timestamp = normalizeTimestamp(row?.activity);
      if (timestamp !== null && (latest === null || timestamp > latest)) latest = timestamp;
    } catch {
      // Individual optional tables/columns are compatibility evidence only.
    }
  }
  return latest;
}

/** Reads the latest active or terminal lifecycle for every persisted Task child. */
export function listOpenCodeChildActivitySnapshots(
  databasePath = getOpenCodeDatabasePath(),
): OpenCodeChildActivitySnapshot[] {
  if (!fsSync.existsSync(databasePath)) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 50 });
    const columns = new Set((db.prepare('PRAGMA table_info(part)').all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has('data')) return [];
    const created = columns.has('time_created') ? 'time_created' : 'NULL';
    const updated = columns.has('time_updated') ? 'time_updated' : 'NULL';
    const rows = db.prepare(`SELECT data, ${created} AS time_created, ${updated} AS time_updated FROM part ORDER BY COALESCE(${updated}, ${created}) ASC`).all() as PartRow[];
    const latest = new Map<string, SnapshotPartActivity>();
    for (const row of rows) {
      for (const activity of inspectSnapshotPart(row)) {
        if (['pending', 'running', 'completed', 'error', 'cancelled'].includes(activity.state)) {
          latest.set(activity.providerSessionId, activity);
        }
      }
    }
    return Array.from(latest.values(), (activity) => {
      const childActivityAt = readLatestChildActivity(db!, activity.providerSessionId);
      const lastActivityAt = Math.max(activity.taskUpdatedAt ?? 0, childActivityAt ?? 0) || null;
      return {
        providerSessionId: activity.providerSessionId,
        startedAt: activity.startedAt,
        statusText: activity.statusText,
        state: activity.state as OpenCodeChildActivitySnapshot['state'],
        taskUpdatedAt: activity.taskUpdatedAt,
        childActivityAt,
        lastActivityAt,
      };
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * Reads active OpenCode Task/subagent parts without mutating or synchronizing
 * the provider database. Missing, incompatible, malformed, locked, or old
 * databases fail open by returning an empty native-activity snapshot.
 *
 * The optional path exists for owning-module tests and does not change the
 * production default, which follows OpenCode's XDG data location.
 */
export function listOpenCodeRunningChildSessions(
  databasePath = getOpenCodeDatabasePath(),
): OpenCodeActiveChildSession[] {
  if (!fsSync.existsSync(databasePath)) {
    return [];
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 50,
    });

    const columns = db.prepare('PRAGMA table_info(part)').all() as Array<{ name?: unknown }>;
    const columnNames = new Set(
      columns
        .map((column) => (typeof column.name === 'string' ? column.name : null))
        .filter((name): name is string => name !== null),
    );
    if (!columnNames.has('data')) {
      return [];
    }

    const timeCreatedExpression = columnNames.has('time_created') ? 'time_created' : 'NULL';
    const timeUpdatedExpression = columnNames.has('time_updated') ? 'time_updated' : 'NULL';
    const rows = db.prepare(`
      SELECT
        data,
        ${timeCreatedExpression} AS time_created,
        ${timeUpdatedExpression} AS time_updated
      FROM part
      ORDER BY COALESCE(${timeUpdatedExpression}, ${timeCreatedExpression}) ASC
    `).all() as PartRow[];
    const active = new Map<string, PartActivity>();

    for (const row of rows) {
      for (const candidate of inspectPart(row)) {
        if (!ACTIVE_TOOL_STATUSES.has(candidate.state)) {
          active.delete(candidate.providerSessionId);
          continue;
        }

        const existing = active.get(candidate.providerSessionId);
        if (!existing) {
          active.set(candidate.providerSessionId, candidate);
          continue;
        }

        const existingStart = existing.startedAt ?? Number.POSITIVE_INFINITY;
        const candidateStart = candidate.startedAt ?? Number.POSITIVE_INFINITY;
        if (candidateStart < existingStart) {
          existing.startedAt = candidate.startedAt;
        }
        if (!existing.statusText && candidate.statusText) {
          existing.statusText = candidate.statusText;
        }
      }
    }

    return Array.from(active.values()).map(({ state: _state, ...activity }) => activity);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
