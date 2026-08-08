import { Database } from 'better-sqlite3';

import {
  APPOINTMENTS_INDEXES_SQL,
  APPOINTMENTS_TABLE_SCHEMA_SQL,
  APP_CONFIG_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSION_RUN_STATE_INDEXES_SQL,
  SESSION_RUN_STATE_TABLE_SCHEMA_SQL,
  SESSION_RUN_HISTORY_INDEXES_SQL,
  SESSION_RUN_HISTORY_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';

const SQLITE_UUID_SQL = `
lower(hex(randomblob(4))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(6)))
`;

const OPENCODE_HIERARCHY_BACKFILL_VERSION = 1;
const OPENCODE_HIERARCHY_BACKFILL_MARKER = 'opencode_hierarchy_backfill_version';

type TableInfoRow = {
  name: string;
  pk: number;
};

const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    console.log(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );

const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];

const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

  if (hasSessionsTable) {
    console.log('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        custom_name,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names
      WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
    return;
  }

  console.log('Running migration: Renaming session_names table to sessions');
  db.exec('ALTER TABLE session_names RENAME TO sessions');
};

const migrateLegacyWorkspaceTableIntoProjects = (db: Database): void => {
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);

  if (!tableExists(db, 'workspace_original_paths')) {
    return;
  }

  console.log('Running migration: Migrating workspace_original_paths data into projects');
  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      CASE
        WHEN workspace_id IS NULL OR trim(workspace_id) = ''
        THEN ${SQLITE_UUID_SQL}
        ELSE workspace_id
      END,
      workspace_path,
      custom_workspace_name,
      COALESCE(isStarred, 0),
      0
    FROM workspace_original_paths
    WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
    ON CONFLICT(project_path) DO UPDATE SET
      custom_project_name = COALESCE(projects.custom_project_name, excluded.custom_project_name),
      isStarred = COALESCE(projects.isStarred, excluded.isStarred)
  `);
};

const rebuildProjectsTableWithPrimaryKeySchema = (db: Database): void => {
  const hasProjectsTable = tableExists(db, 'projects');
  if (!hasProjectsTable) {
    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    return;
  }

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  const hasProjectIdPrimaryKey = projectsTableInfo.some(
    (column) => column.name === 'project_id' && column.pk === 1,
  );

  if (hasProjectIdPrimaryKey) {
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'custom_project_name', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isStarred', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    db.exec(`
      UPDATE projects
      SET project_id = ${SQLITE_UUID_SQL}
      WHERE project_id IS NULL OR trim(project_id) = ''
    `);
    return;
  }

  console.log('Running migration: Rebuilding projects table to enforce project_id primary key');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const customProjectNameExpression = columnNames.includes('custom_project_name')
    ? 'custom_project_name'
    : columnNames.includes('custom_workspace_name')
      ? 'custom_workspace_name'
      : 'NULL';

  const isStarredExpression = columnNames.includes('isStarred') ? 'COALESCE(isStarred, 0)' : '0';

  const isArchivedExpression = columnNames.includes('isArchived') ? 'COALESCE(isArchived, 0)' : '0';

  const projectIdExpression = columnNames.includes('project_id')
    ? `CASE
         WHEN project_id IS NULL OR trim(project_id) = ''
         THEN ${SQLITE_UUID_SQL}
         ELSE project_id
       END`
    : SQLITE_UUID_SQL;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS projects__new');
    db.exec(`
      CREATE TABLE projects__new (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          ${projectPathExpression} AS project_path,
          ${customProjectNameExpression} AS custom_project_name,
          ${isStarredExpression} AS isStarred,
          ${isArchivedExpression} AS isArchived,
          ${projectIdExpression} AS candidate_project_id,
          rowid AS source_rowid
        FROM projects
        WHERE ${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> ''
      ),
      deduped_paths AS (
        SELECT
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          candidate_project_id,
          source_rowid,
          ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY source_rowid) AS project_path_rank
        FROM source_rows
      ),
      prepared_rows AS (
        SELECT
          CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY candidate_project_id ORDER BY source_rowid) = 1
            THEN candidate_project_id
            ELSE ${SQLITE_UUID_SQL}
          END AS project_id,
          project_path,
          custom_project_name,
          isStarred,
          isArchived
        FROM deduped_paths
        WHERE project_path_rank = 1
      )
      INSERT INTO projects__new (
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      )
      SELECT
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      FROM prepared_rows
    `);
    db.exec('DROP TABLE projects');
    db.exec('ALTER TABLE projects__new RENAME TO projects');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

const rebuildSessionsTableWithProjectSchema = (db: Database): boolean => {
  const hasSessions = tableExists(db, 'sessions');
  if (!hasSessions) {
    db.exec(SESSIONS_TABLE_SCHEMA_SQL);
    return false;
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);
  const primaryKeyColumns = sessionsTableInfo
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  const shouldRebuild =
    !columnNames.includes('project_path') ||
    primaryKeyColumns.length !== 1 ||
    primaryKeyColumns[0] !== 'session_id' ||
    !columnNames.includes('provider');

  const hadProviderParentSessionId = columnNames.includes('provider_parent_session_id');

  if (!shouldRebuild) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    db.exec('UPDATE sessions SET isArchived = COALESCE(isArchived, 0)');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return !hadProviderParentSessionId;
  }

  console.log('Running migration: Rebuilding sessions table to project-based schema');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const providerExpression = columnNames.includes('provider')
    ? "COALESCE(provider, 'claude')"
    : "'claude'";

  const customNameExpression = columnNames.includes('custom_name')
    ? 'custom_name'
    : 'NULL';

  const jsonlPathExpression = columnNames.includes('jsonl_path')
    ? 'jsonl_path'
    : 'NULL';

  const providerSessionIdExpression = columnNames.includes('provider_session_id')
    ? 'provider_session_id'
    : 'session_id';

  const modelExpression = columnNames.includes('model') ? 'model' : 'NULL';

  const agentExpression = columnNames.includes('agent') ? 'agent' : 'NULL';

  const providerParentSessionIdExpression = columnNames.includes('provider_parent_session_id')
    ? 'provider_parent_session_id'
    : 'NULL';

  const isArchivedExpression = columnNames.includes('isArchived')
    ? 'COALESCE(isArchived, 0)'
    : '0';

  const createdAtExpression = columnNames.includes('created_at')
    ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  const updatedAtExpression = columnNames.includes('updated_at')
    ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS sessions__new');
    db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        provider_session_id TEXT,
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        model TEXT,
        agent TEXT,
        provider_parent_session_id TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          session_id,
          ${providerExpression} AS provider,
          ${providerSessionIdExpression} AS provider_session_id,
          ${customNameExpression} AS custom_name,
          ${projectPathExpression} AS project_path,
          ${jsonlPathExpression} AS jsonl_path,
          ${modelExpression} AS model,
          ${agentExpression} AS agent,
          ${providerParentSessionIdExpression} AS provider_parent_session_id,
          ${isArchivedExpression} AS isArchived,
          ${createdAtExpression} AS created_at,
          ${updatedAtExpression} AS updated_at,
          rowid AS source_rowid
        FROM sessions
        WHERE session_id IS NOT NULL AND trim(session_id) <> ''
      ),
      ranked_rows AS (
        SELECT
          session_id,
          provider,
          provider_session_id,
          custom_name,
          project_path,
          jsonl_path,
          model,
          agent,
          provider_parent_session_id,
          isArchived,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank
        FROM source_rows
      )
      INSERT INTO sessions__new (
        session_id,
        provider,
        provider_session_id,
        custom_name,
        project_path,
        jsonl_path,
        model,
        agent,
        provider_parent_session_id,
        isArchived,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        provider,
        provider_session_id,
        custom_name,
        project_path,
        jsonl_path,
        model,
        agent,
        provider_parent_session_id,
        isArchived,
        created_at,
        updated_at
      FROM ranked_rows
      WHERE session_rank = 1
    `);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions__new RENAME TO sessions');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  return !hadProviderParentSessionId;
};

/**
 * Adds the `provider_session_id` mapping column used by the session gateway.
 *
 * Rows that existed before this migration were always keyed directly by the
 * provider-native session id, so backfilling `provider_session_id` with
 * `session_id` keeps every legacy row resolvable through the new mapping.
 */
const addProviderSessionIdMapping = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  if (columnNames.includes('provider_session_id')) {
    return;
  }

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'provider_session_id', 'TEXT');
  db.exec(`
    UPDATE sessions
    SET provider_session_id = session_id
    WHERE provider_session_id IS NULL
  `);
};

/**
 * Adds the `model` column that records which model each session runs with.
 *
 * Left NULL for pre-existing rows on purpose: the model resolver falls back to
 * the provider-native lookup for sessions the app has never sent on, so a
 * backfilled guess would only mask the real value.
 */
const addSessionModelColumn = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'model', 'TEXT');
};

/**
 * Adds the OpenCode agent recorded for each session.
 *
 * Adding this column invalidates the incremental provider scan cursor once so
 * pre-existing OpenCode parent and subagent rows are re-read from opencode.db.
 */
const addSessionAgentColumn = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  if (columnNames.includes('agent')) {
    return;
  }

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'agent', 'TEXT');
  if (tableExists(db, 'scan_state')) {
    db.exec('UPDATE scan_state SET last_scanned_at = NULL WHERE id = 1');
  }
};

/**
 * Adds the provider-native parent mapping used by recursive OpenCode sessions.
 *
 * Existing OpenCode databases must be rescanned once because rows already
 * indexed before this column existed have no persisted relationship metadata.
 */
const addProviderParentSessionIdColumn = (db: Database): boolean => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  if (columnNames.includes('provider_parent_session_id')) {
    return false;
  }

  addColumnToTableIfNotExists(
    db,
    'sessions',
    columnNames,
    'provider_parent_session_id',
    'TEXT',
  );
  return true;
};

/**
 * Activates the one-time OpenCode hierarchy rescan independently of the
 * provider-parent column migration. A partially upgraded database can already
 * have the column while still retaining a cursor from a pre-hierarchy scan.
 */
const ensureOpenCodeHierarchyBackfill = (db: Database): boolean => {
  const marker = db
    .prepare('SELECT value FROM app_config WHERE key = ?')
    .get(OPENCODE_HIERARCHY_BACKFILL_MARKER) as { value: string } | undefined;
  const storedVersion = Number.parseInt(marker?.value ?? '', 10);

  if (Number.isSafeInteger(storedVersion) && storedVersion >= OPENCODE_HIERARCHY_BACKFILL_VERSION) {
    return false;
  }

  db.transaction(() => {
    db.prepare('UPDATE scan_state SET last_scanned_at = NULL WHERE id = 1').run();
    db.prepare(`
      INSERT INTO app_config (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(OPENCODE_HIERARCHY_BACKFILL_MARKER, String(OPENCODE_HIERARCHY_BACKFILL_VERSION));
  })();

  return true;
};

const ensureProjectsForSessionPaths = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      ${SQLITE_UUID_SQL},
      project_path,
      NULL,
      0,
      0
    FROM sessions
    WHERE project_path IS NOT NULL AND trim(project_path) <> ''
    ON CONFLICT(project_path) DO NOTHING
  `);
};

const migrateAppointmentsQueueSchema = (db: Database): void => {
  if (!tableExists(db, 'appointments')) {
    db.exec(APPOINTMENTS_TABLE_SCHEMA_SQL);
    return;
  }
  const columns = getTableInfo(db, 'appointments').map(({ name }) => name);
  addColumnToTableIfNotExists(db, 'appointments', columns, 'queue_position', 'INTEGER');
  addColumnToTableIfNotExists(db, 'appointments', columns, 'run_generation', 'INTEGER');

  const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'appointments'").get() as { sql?: string } | undefined)?.sql ?? '';
  if (!tableSql.includes("'queue'")) {
    console.log('Running migration: Rebuilding appointments table for queue triggers');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN TRANSACTION');
      db.exec('ALTER TABLE appointments RENAME TO appointments__legacy');
      db.exec(APPOINTMENTS_TABLE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO appointments (
          id, project_id, session_id, user_id, provider, prompt, options_json,
          attachments_json, trigger_type, due_at, timer_duration_ms, project_idle_since,
          queue_position, run_generation, is_active, status, error_message, created_at,
          updated_at, claimed_at, completed_at
        )
        SELECT
          id, project_id, session_id, user_id, provider, prompt, options_json,
          attachments_json, trigger_type, due_at, timer_duration_ms, project_idle_since,
          queue_position, run_generation, is_active, status, error_message, created_at,
          updated_at, claimed_at, completed_at
        FROM appointments__legacy
      `);
      db.exec('DROP TABLE appointments__legacy');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  db.exec(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY project_id, user_id
        ORDER BY created_at, id
      ) AS position
      FROM appointments
      WHERE trigger_type = 'queue' AND status NOT IN ('completed', 'failed', 'cancelled')
    )
    UPDATE appointments
    SET queue_position = (SELECT position FROM ranked WHERE ranked.id = appointments.id)
    WHERE id IN (SELECT id FROM ranked) AND queue_position IS NULL
  `);
};

/**
 * Repairs app-created OpenCode appointment sessions corrupted by the former
 * repeated provider-id backfill while preserving provider-native legacy rows.
 */
const repairAppointmentOpenCodeSessionMappings = (db: Database): void => {
  db.exec(`
    UPDATE sessions
    SET provider_session_id = NULL
    WHERE provider = 'opencode'
      AND provider_session_id = session_id
      AND length(session_id) = 36
      AND substr(session_id, 9, 1) = '-'
      AND substr(session_id, 14, 1) = '-'
      AND substr(session_id, 19, 1) = '-'
      AND substr(session_id, 24, 1) = '-'
      AND replace(session_id, '-', '') NOT GLOB '*[^0-9A-Fa-f]*'
      AND EXISTS (
        SELECT 1
        FROM appointments
        WHERE appointments.session_id = sessions.session_id
      )
  `);
};

export const runMigrations = (db: Database) => {
  try {
    const usersTableInfo = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColumnNames = usersTableInfo.map((column) => column.name);

    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_name', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_email', 'TEXT');
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'has_completed_onboarding',
      'BOOLEAN DEFAULT 0'
    );

    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
    db.exec(VAPID_KEYS_TABLE_SCHEMA_SQL);
    db.exec(PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)');
    db.exec(NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled)');

    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    rebuildProjectsTableWithPrimaryKeySchema(db);

    migrateLegacyWorkspaceTableIntoProjects(db);
    const providerParentSessionBackfillRequired = rebuildSessionsTableWithProjectSchema(db);
    migrateLegacySessionNames(db);
    addProviderSessionIdMapping(db);
    addSessionModelColumn(db);
    addSessionAgentColumn(db);
    const providerParentSessionIdAdded = addProviderParentSessionIdColumn(db);
    ensureProjectsForSessionPaths(db);

    db.exec('CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_provider_session_id ON sessions(provider_session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_is_archived ON sessions(isArchived)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_starred ON projects(isStarred)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(isArchived)');

    db.exec(SESSION_RUN_STATE_TABLE_SCHEMA_SQL);
    db.exec(SESSION_RUN_STATE_INDEXES_SQL);
    db.exec(SESSION_RUN_HISTORY_TABLE_SCHEMA_SQL);
    db.exec(SESSION_RUN_HISTORY_INDEXES_SQL);
    migrateAppointmentsQueueSchema(db);
    repairAppointmentOpenCodeSessionMappings(db);
    db.exec(APPOINTMENTS_INDEXES_SQL);

    db.exec('DROP INDEX IF EXISTS idx_session_names_lookup');
    db.exec('DROP INDEX IF EXISTS idx_sessions_workspace_path');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_is_starred');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_workspace_id');

    if (tableExists(db, 'workspace_original_paths')) {
      console.log('Running migration: Dropping legacy workspace_original_paths table');
      db.exec('DROP TABLE workspace_original_paths');
    }

    db.exec(LAST_SCANNED_AT_SQL);
    const hierarchyBackfillRequired = ensureOpenCodeHierarchyBackfill(db);
    if (
      (providerParentSessionBackfillRequired || providerParentSessionIdAdded)
      && !hierarchyBackfillRequired
    ) {
      db.exec('UPDATE scan_state SET last_scanned_at = NULL WHERE id = 1');
    }
    console.log('Database migrations completed successfully');
  } catch (error: any) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};
