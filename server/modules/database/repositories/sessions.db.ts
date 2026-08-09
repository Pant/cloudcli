import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { normalizeProjectPath } from '@/shared/utils.js';

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  /** Model this session runs with; NULL until the app records one for it. */
  model: string | null;
  /** OpenCode agent this session runs with; NULL for other providers or new sessions. */
  agent: string | null;
  /** Provider-native parent id; NULL for roots and providers without hierarchy metadata. */
  provider_parent_session_id: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type ProjectSessionPage = {
  rows: SessionRow[];
  total: number;
  rootTotal: number;
  rootOffset: number;
  nextOffset: number;
  hasMore: boolean;
};

/**
 * App-facing meaning of a stored provider parent relationship.
 *
 * `null` is reserved for an authoritative provider root. `undefined` means a
 * provider parent id exists but its native-to-app mapping is not available yet.
 * Resolved values are canonical app session ids; native ids never leave this
 * repository contract.
 */
type SessionParentResolution = {
  kind: 'root' | 'unresolved' | 'resolved';
  parentSessionId: string | null | undefined;
};

type SessionManifestRow = Pick<
  SessionRow,
  'session_id' | 'provider' | 'provider_session_id' | 'isArchived' | 'created_at' | 'updated_at'
>;

const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, model, agent, provider_parent_session_id, isArchived, created_at, updated_at';

const SESSION_MANIFEST_ROW_COLUMNS =
  'session_id, provider, provider_session_id, isArchived, created_at, updated_at';

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

export const sessionsDb = {
  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row.
   */
  createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null,
    agent?: string | null,
    providerParentSessionId?: string | null
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    projectsDb.createProjectPath(normalizedProjectPath);

    const existing = db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { session_id: string } | undefined;

    if (existing) {
      const parentUpdate = providerParentSessionId === undefined
        ? ''
        : ', provider_parent_session_id = ?';
      const updateParams: Array<string | number | null> = [
        provider,
        updatedAtValue,
        normalizedProjectPath,
        jsonlPath ?? null,
        customName ?? null,
        agent ?? null,
      ];
      if (providerParentSessionId !== undefined) {
        updateParams.push(providerParentSessionId);
      }
      updateParams.push(existing.session_id);
      db.prepare(
        `UPDATE sessions SET
           provider = ?,
           updated_at = COALESCE(?, CURRENT_TIMESTAMP),
           project_path = ?,
           jsonl_path = ?,
           isArchived = 0,
           custom_name = COALESCE(?, custom_name),
           agent = COALESCE(?, agent)
           ${parentUpdate}
         WHERE session_id = ?`
      ).run(...updateParams);

      return existing.session_id;
    }

    // Sessions created outside the app (directly via the provider CLI) are
    // keyed by the provider-native id for both columns. The ON CONFLICT path
    // covers legacy rows that predate the provider_session_id mapping.
    const parentInsertColumns = providerParentSessionId === undefined
      ? ''
      : ', provider_parent_session_id';
    const parentInsertValues = providerParentSessionId === undefined ? '' : ', ?';
    const parentConflictUpdate = providerParentSessionId === undefined
      ? ''
      : ', provider_parent_session_id = excluded.provider_parent_session_id';
    const insertParams: Array<string | number | null> = [
      providerSessionId,
      provider,
      providerSessionId,
      customName ?? null,
      normalizedProjectPath,
      jsonlPath ?? null,
      agent ?? null,
    ];
    if (providerParentSessionId !== undefined) {
      insertParams.push(providerParentSessionId);
    }
    insertParams.push(createdAtValue, updatedAtValue);
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, agent${parentInsertColumns}, isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?${parentInsertValues}, 0, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         agent = COALESCE(excluded.agent, sessions.agent),
         isArchived = 0,
         custom_name = COALESCE(excluded.custom_name, sessions.custom_name)${parentConflictUpdate}`
    ).run(...insertParams);

    return providerSessionId;
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping.
   */
  createAppSession(sessionId: string, provider: string, projectPath: string): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(sessionId, provider, normalizedProjectPath);

    return sessionId;
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path and name
   * are adopted and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): string[] {
    const db = getConnection();

    const merge = db.transaction((): string[] => {
      const session = db
        .prepare('SELECT provider, provider_session_id FROM sessions WHERE session_id = ? LIMIT 1')
        .get(sessionId) as { provider: string; provider_session_id: string | null } | undefined;
      const affectedNativeParentIds = session
        ? new Set([session.provider_session_id, providerSessionId].filter((value): value is string => Boolean(value)))
        : new Set<string>();
      const previousChildren = session
        ? sessionsDb.getChildCanonicalParentSessionIds(session.provider, Array.from(affectedNativeParentIds))
        : new Map<string, string | undefined>();

      const duplicate = db
        .prepare(
          `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      if (duplicate) {
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        db.prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = COALESCE(jsonl_path, ?),
             custom_name = COALESCE(custom_name, ?),
             agent = COALESCE(agent, ?),
             provider_parent_session_id = COALESCE(provider_parent_session_id, ?),
             updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?`
        ).run(
          providerSessionId,
          duplicate.jsonl_path,
          duplicate.custom_name,
          duplicate.agent,
          duplicate.provider_parent_session_id,
          sessionId,
        );
      } else {
        db.prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        ).run(providerSessionId, sessionId);
      }

      if (!session) {
        return [];
      }

      const nextChildren = sessionsDb.getChildCanonicalParentSessionIds(
        session.provider,
        Array.from(affectedNativeParentIds),
      );
      return Array.from(new Set([...previousChildren.keys(), ...nextChildren.keys()]))
        .filter((childSessionId) => (
          previousChildren.get(childSessionId) !== nextChildren.get(childSessionId)
        ));
    });

    return merge();
  },

  /**
   * Records the model one session runs with.
   *
   * Called both when the user picks a model for the session and on every send,
   * so the row always reflects what the session last ran with and reopening it
   * restores that model instead of a catalog default.
   */
  setSessionModel(sessionId: string, model: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET model = ?
       WHERE session_id = ?`
    ).run(model, sessionId);
  },

  /**
   * Records the OpenCode agent selected for one session.
   *
   * The websocket gateway calls this before each OpenCode run so a UI choice
   * remains session-scoped even before the provider database watcher catches up.
   */
  setSessionAgent(sessionId: string, agent: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET agent = ?
       WHERE session_id = ?`
    ).run(agent, sessionId);
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?
         , updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(providerSessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session's stored relationship without conflating a root with
   * a child whose provider-native parent has not been indexed yet.
   */
  getSessionParentResolution(sessionId: string): SessionParentResolution {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT child.provider_session_id,
                child.provider_parent_session_id,
                parent.session_id AS parent_session_id
         FROM sessions child
         LEFT JOIN sessions parent
           ON parent.provider = child.provider
          AND parent.provider_session_id = child.provider_parent_session_id
          AND parent.session_id <> child.session_id
         WHERE child.session_id = ?
         LIMIT 1`
      )
      .get(sessionId) as {
        provider_parent_session_id: string | null;
        provider_session_id: string | null;
        parent_session_id: string | null;
      } | undefined;

    if (!row) {
      return { kind: 'unresolved', parentSessionId: undefined };
    }

    if (row.provider_parent_session_id === null || row.provider_parent_session_id === row.provider_session_id) {
      return { kind: 'root', parentSessionId: null };
    }

    if (!row.parent_session_id) {
      return { kind: 'unresolved', parentSessionId: undefined };
    }

    return { kind: 'resolved', parentSessionId: row.parent_session_id };
  },

  /**
   * Resolves a stored provider-native parent to a canonical app id. Undefined
   * means unresolved; null means an authoritative provider root.
   */
  getCanonicalParentSessionId(sessionId: string): string | null | undefined {
    return sessionsDb.getSessionParentResolution(sessionId).parentSessionId;
  },

  /**
   * Returns child ids for one provider-native parent, preserving each child's
   * current canonical parent so mapping callers can detect newly resolved or
   * re-canonicalized relationships without scanning historical rows.
   */
  getChildCanonicalParentSessionIds(
    provider: string,
    providerSessionIds: string[],
  ): Map<string, string | undefined> {
    if (providerSessionIds.length === 0) {
      return new Map();
    }

    const db = getConnection();
    const placeholders = providerSessionIds.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT child.session_id,
              parent.session_id AS parent_session_id
       FROM sessions child
       LEFT JOIN sessions parent
         ON parent.provider = child.provider
        AND parent.provider_session_id = child.provider_parent_session_id
        AND parent.session_id <> child.session_id
       WHERE child.provider = ?
         AND child.provider_parent_session_id IN (${placeholders})`,
    ).all(provider, ...providerSessionIds) as Array<{
      session_id: string;
      parent_session_id: string | null;
    }>;

    return new Map(rows.map((row) => [row.session_id, row.parent_session_id ?? undefined]));
  },

  /**
   * Lists children still waiting for a provider-native parent mapping. The
   * result is intentionally scoped to one native id so synchronization can
   * rebroadcast only rows repaired by the current disk update.
   */
  getUnresolvedChildrenForProviderParent(provider: string, providerSessionId: string): string[] {
    const db = getConnection();
    const rows = db.prepare(
      `SELECT child.session_id
       FROM sessions child
       LEFT JOIN sessions parent
         ON parent.provider = child.provider
        AND parent.provider_session_id = child.provider_parent_session_id
        AND parent.session_id <> child.session_id
       WHERE child.provider = ?
         AND child.provider_parent_session_id = ?
         AND parent.session_id IS NULL
         AND child.session_id <> ?`,
    ).all(provider, providerSessionId, providerSessionId) as Array<{ session_id: string }>;

    return rows.map((row) => row.session_id);
  },

  /**
   * Finds the newest app-created session for a project that is still waiting
   * for its provider-native id to be recorded.
   *
   * Primary intention: OpenCode can expose a new session in its shared
   * `opencode.db` before the websocket runtime reports that same provider id
   * back to our app. At that moment the sidebar already has an optimistic
   * app-owned session row, but the watcher only knows the provider-native id.
   *
   * Without this lookup, the synchronizer would insert a second row keyed by
   * the provider id, then `assignProviderSessionId()` would merge it a moment
   * later. That eventually self-heals, but on slow networks the user can still
   * briefly see two sidebar sessions for the same conversation.
   *
   * This helper lets the synchronizer claim the pending app row first, so the
   * provider id is attached before any watcher-created row exists. The result
   * is simpler than frontend dedupe and keeps the race resolved at the source.
   */
  findLatestPendingAppSession(provider: string, projectPath: string): SessionRow | null {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider = ?
           AND project_path = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`
      )
      .get(provider, normalizedProjectPath) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Returns metadata-only rows for the browser session cache manifest.
   *
   * This intentionally selects no transcript path or message data and combines
   * active and archived rows in one query so each indexed app session appears
   * exactly once. The persisted timestamp and app id tie-breaker make ordering
   * deterministic for clients reconciling a cached snapshot.
   */
  getSessionManifestRows(): SessionManifestRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_MANIFEST_ROW_COLUMNS}
         FROM sessions
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id ASC`
      )
      .all() as SessionManifestRow[];

    return rows.map((row) => normalizeSessionRow(row as SessionRow) as SessionManifestRow);
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Returns a root-aligned active session page.
   *
   * Pagination is intentionally performed in memory after reading the active
   * project rows. The relationship is provider-native and may be unresolved,
   * cross-project, cyclic, or discovered out of order; resolving that graph in
   * one place keeps those malformed cases from producing split trees or an
   * unbounded recursive SQLite query. A page selects roots by recursive
   * subtree activity, then returns every active node in each selected closure.
   */
  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): ProjectSessionPage {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
          WHERE project_path = ?
            AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];

    const rowById = new Map(rows.map((row) => [row.session_id, row]));
    const parentById = new Map<string, string>();

    for (const row of rows) {
      if (!row.provider_parent_session_id || row.provider_parent_session_id === row.provider_session_id) {
        continue;
      }

      const parent = rows.find(
        (candidate) => candidate.provider === row.provider
          && candidate.provider_session_id === row.provider_parent_session_id
          && candidate.session_id !== row.session_id,
      );
      if (parent) {
        parentById.set(row.session_id, parent.session_id);
      }
    }

    // Find the selected root for each node. A cycle has no natural root, so use
    // the lexicographically smallest node in the cycle; this makes pagination
    // deterministic while still keeping the whole malformed component together.
    const rootById = new Map<string, string>();
    const resolveRoot = (sessionId: string): string => {
      const cachedRoot = rootById.get(sessionId);
      if (cachedRoot) {
        return cachedRoot;
      }

      const pathIds: string[] = [];
      const pathIndex = new Map<string, number>();
      let currentId = sessionId;

      while (true) {
        const existingRoot = rootById.get(currentId);
        if (existingRoot) {
          for (const pathId of pathIds) {
            rootById.set(pathId, existingRoot);
          }
          return existingRoot;
        }

        const cycleStart = pathIndex.get(currentId);
        if (cycleStart !== undefined) {
          const cycleIds = pathIds.slice(cycleStart).sort();
          const cycleRoot = cycleIds[0] ?? currentId;
          for (const pathId of pathIds) {
            rootById.set(pathId, cycleRoot);
          }
          rootById.set(currentId, cycleRoot);
          return cycleRoot;
        }

        pathIndex.set(currentId, pathIds.length);
        pathIds.push(currentId);
        const parentId = parentById.get(currentId);
        if (!parentId || !rowById.has(parentId)) {
          for (const pathId of pathIds) {
            rootById.set(pathId, currentId);
          }
          return currentId;
        }
        currentId = parentId;
      }
    };

    for (const row of rows) {
      resolveRoot(row.session_id);
    }

    const childrenByParent = new Map<string, string[]>();
    for (const [childId, parentId] of parentById) {
      const children = childrenByParent.get(parentId) ?? [];
      children.push(childId);
      childrenByParent.set(parentId, children);
    }

    const activityOf = (row: SessionRow): number => {
      const updated = Date.parse(row.updated_at);
      const created = Date.parse(row.created_at);
      return Math.max(Number.isNaN(updated) ? 0 : updated, Number.isNaN(created) ? 0 : created);
    };
    const activityByRoot = new Map<string, number>();
    for (const row of rows) {
      const rootId = rootById.get(row.session_id) ?? row.session_id;
      activityByRoot.set(rootId, Math.max(activityByRoot.get(rootId) ?? 0, activityOf(row)));
    }

    const rootIds = Array.from(activityByRoot.keys()).sort((left, right) => {
      const activityDifference = (activityByRoot.get(right) ?? 0) - (activityByRoot.get(left) ?? 0);
      return activityDifference || right.localeCompare(left);
    });
    const pageLimit = Math.max(1, limit);
    const selectedRootIds = rootIds.slice(Math.max(0, offset), Math.max(0, offset) + pageLimit);
    const selectedRootSet = new Set(selectedRootIds);
    const selectedRows: SessionRow[] = [];

    const appendClosure = (rootId: string): void => {
      const visited = new Set<string>();
      const visit = (sessionId: string): void => {
        if (visited.has(sessionId)) {
          return;
        }
        visited.add(sessionId);

        const row = rowById.get(sessionId);
        if (row) {
          selectedRows.push(row);
        }

        const childIds = (childrenByParent.get(sessionId) ?? []).sort((left, right) => {
          const rightRow = rowById.get(right);
          const leftRow = rowById.get(left);
          const activityDifference = activityOf(rightRow ?? ({} as SessionRow)) - activityOf(leftRow ?? ({} as SessionRow));
          return activityDifference || right.localeCompare(left);
        });
        for (const childId of childIds) {
          if ((rootById.get(childId) ?? childId) === rootId) {
            visit(childId);
          }
        }
      };

      visit(rootId);
      // A malformed cycle can be reached from a non-representative path only
      // through a back-edge. Include any remaining members of this component
      // once so descendants are never silently lost from the selected page.
      for (const row of rows) {
        if ((rootById.get(row.session_id) ?? row.session_id) === rootId) {
          visit(row.session_id);
        }
      }
    };

    for (const rootId of selectedRootIds) {
      if (selectedRootSet.has(rootId)) {
        appendClosure(rootId);
      }
    }

    return {
      rows: normalizeSessionRows(selectedRows),
      total: rows.length,
      rootTotal: rootIds.length,
      rootOffset: Math.max(0, offset),
      nextOffset: Math.max(0, offset) + selectedRootIds.length,
      hasMore: Math.max(0, offset) + selectedRootIds.length < rootIds.length,
    };
  },

  /**
   * Resolves a batch of rows while retaining explicit-root and unresolved
   * states for browser-facing serializers.
   */
  getSessionParentResolutions(sessionIds: string[]): Map<string, SessionParentResolution> {
    if (sessionIds.length === 0) {
      return new Map();
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT child.session_id,
              child.provider_session_id,
              child.provider_parent_session_id,
              parent.session_id AS parent_session_id
       FROM sessions child
       LEFT JOIN sessions parent
         ON parent.provider = child.provider
        AND parent.provider_session_id = child.provider_parent_session_id
        AND parent.session_id <> child.session_id
       WHERE child.session_id IN (${placeholders})`,
    ).all(...sessionIds) as Array<{
      session_id: string;
      provider_session_id: string | null;
      provider_parent_session_id: string | null;
      parent_session_id: string | null;
    }>;

    return new Map<string, SessionParentResolution>(rows.map((row) => {
      if (row.provider_parent_session_id === null || row.provider_parent_session_id === row.provider_session_id) {
        return [row.session_id, { kind: 'root', parentSessionId: null }];
      }
      if (!row.parent_session_id) {
        return [row.session_id, { kind: 'unresolved', parentSessionId: undefined }];
      }
      return [row.session_id, { kind: 'resolved', parentSessionId: row.parent_session_id }];
    }));
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .get(normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },
};
