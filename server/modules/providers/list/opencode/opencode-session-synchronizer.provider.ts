import fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  getOpenCodeDatabasePath,
  normalizeProviderTimestamp,
  normalizeSessionName,
  readJsonRecord,
  readOptionalString,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

type OpenCodeSessionRow = {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number | null;
  time_updated: number | null;
  worktree: string | null;
  agent: string | null;
  parent_id: string | null | undefined;
};

type SynchronizeRowsResult = {
  processed: number;
  sessionIds: string[];
};

/**
 * Session indexer for OpenCode's SQLite-backed session store.
 */
export class OpenCodeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'opencode' as const;

  /**
   * Scans OpenCode's shared opencode.db and upserts active sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const result = this.synchronizeRows(since);
    return result.processed;
  }

  /**
   * Handles watcher changes for opencode.db.
   */
  async synchronizeFile(filePath: string): Promise<string | string[] | null> {
    if (path.basename(filePath) !== 'opencode.db') {
      return null;
    }

    const result = this.synchronizeRows(undefined, undefined, true);
    if (result.sessionIds.length === 0) {
      return null;
    }
    return result.sessionIds.length === 1 ? result.sessionIds[0] : result.sessionIds;
  }

  private synchronizeRows(
    since?: Date,
    limit?: number,
    changedOnly = false,
  ): SynchronizeRowsResult {
    const dbPath = getOpenCodeDatabasePath();
    if (!fsSync.existsSync(dbPath)) {
      return { processed: 0, sessionIds: [] };
    }

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const sinceMillis = since?.getTime() ?? null;
      const limitClause = limit ? 'LIMIT ?' : '';
      const params = limit ? [sinceMillis, sinceMillis, limit] : [sinceMillis, sinceMillis];
      const sessionColumns = db.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
      const agentExpression = sessionColumns.some((column) => column.name === 'agent')
        ? 's.agent'
        : 'NULL';
      const parentExpression = sessionColumns.some((column) => column.name === 'parent_id')
        ? 's.parent_id'
        : 'NULL';
      const hasParentIdColumn = sessionColumns.some((column) => column.name === 'parent_id');
      const rows = db.prepare(`
        SELECT
          s.id AS id,
          s.directory AS directory,
          s.title AS title,
          s.time_created AS time_created,
          s.time_updated AS time_updated,
          ${agentExpression} AS agent,
          ${parentExpression} AS parent_id,
          p.worktree AS worktree
        FROM session s
        LEFT JOIN project p ON p.id = s.project_id
        WHERE s.time_archived IS NULL
          AND (? IS NULL OR COALESCE(s.time_updated, s.time_created, 0) >= ?)
        ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC, s.id DESC
        ${limitClause}
      `).all(...params) as OpenCodeSessionRow[];

      let processed = 0;
      const sessionIds: string[] = [];
      for (const row of rows) {
        const indexedSessionIds = this.upsertSession(db, row, changedOnly, hasParentIdColumn);
        if (indexedSessionIds.length === 0) {
          continue;
        }

        sessionIds.push(...indexedSessionIds);
        processed += 1;
      }

      return { processed, sessionIds: Array.from(new Set(sessionIds)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[OpenCodeProvider] Failed to synchronize sessions:', message);
      return { processed: 0, sessionIds: [] };
    } finally {
      db.close();
    }
  }

  private upsertSession(
    db: Database.Database,
    row: OpenCodeSessionRow,
    changedOnly: boolean,
    hasParentIdColumn: boolean,
  ): string[] {
    const sessionId = readOptionalString(row.id);
    const projectPath = readOptionalString(row.directory) ?? readOptionalString(row.worktree);
    if (!sessionId || !projectPath) {
      return [];
    }

    const fallbackTitle = 'Untitled OpenCode Session';
    const pendingAppSession = row.parent_id == null
      ? sessionsDb.getSessionByProviderSessionId(sessionId)
        ?? sessionsDb.getSessionById(sessionId)
        ?? sessionsDb.findLatestPendingAppSession(this.provider, projectPath)
      : null;
    let affectedSessionIds: string[] = [];
    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      // Slow networks can let the sqlite watcher index opencode.db before the
      // runtime reports its provider id back through the websocket mapping.
      // Bind that id to the fresh app row first so the watcher does not create
      // a temporary provider-id sidebar entry for the same session.
      affectedSessionIds = sessionsDb.assignProviderSessionId(pendingAppSession.session_id, sessionId);
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId);
    const existingName = existingSession?.custom_name;

    // Sessions started by sending a message from cloudcli carry a distinct
    // app-allocated session_id mapped to the provider id. For these we title the
    // conversation from the first user message the user typed, matching how the
    // app titles a brand-new conversation. Sessions discovered purely by
    // indexing (session_id === provider_session_id) keep OpenCode's own stored
    // title.
    const isAppCreated =
      existingSession != null &&
      existingSession.provider_session_id != null &&
      existingSession.session_id !== existingSession.provider_session_id;

    let nextName: string | undefined;
    if (existingName && existingName !== fallbackTitle) {
      nextName = existingName;
    } else if (isAppCreated) {
      nextName = this.readFirstUserText(db, sessionId) ?? readOptionalString(row.title);
    } else {
      nextName = readOptionalString(row.title) ?? this.readFirstUserText(db, sessionId);
    }

    const parentSessionId = !hasParentIdColumn
      ? undefined
      : row.parent_id === null
        ? null
        : readOptionalString(row.parent_id) ?? null;
    if (changedOnly && existingSession && !this.hasMaterialChanges(
      existingSession,
      projectPath,
      row,
      parentSessionId,
      normalizeSessionName(nextName, fallbackTitle),
    )) {
      return affectedSessionIds;
    }

    // OpenCode stores every session in one shared sqlite database, so jsonl_path
    // must stay null to avoid deleting opencode.db when one app session is removed.
    // Return the canonical stored row id so watcher-triggered sidebar updates
    // stay on the app session once provider_session_id has already been mapped.
    const unresolvedChildSessionIds = sessionsDb.getUnresolvedChildrenForProviderParent(this.provider, sessionId);
    const indexedSessionId = sessionsDb.createSession(
      sessionId,
      this.provider,
      projectPath,
      normalizeSessionName(nextName, fallbackTitle),
      normalizeProviderTimestamp(row.time_created),
      normalizeProviderTimestamp(row.time_updated ?? row.time_created),
      null,
      readOptionalString(row.agent) ?? null,
      parentSessionId,
    );
    const newlyResolvedChildren = unresolvedChildSessionIds.filter((childSessionId) => (
      childSessionId !== indexedSessionId
      && sessionsDb.getSessionParentResolution(childSessionId).kind === 'resolved'
    ));
    return Array.from(new Set([
      ...affectedSessionIds,
      indexedSessionId,
      ...newlyResolvedChildren,
    ]));
  }

  private hasMaterialChanges(
    existingSession: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
    projectPath: string,
    row: OpenCodeSessionRow,
    parentSessionId: string | null | undefined,
    nextName: string,
  ): boolean {
    const normalizedUpdatedAt = normalizeProviderTimestamp(row.time_updated ?? row.time_created);
    return existingSession.provider !== this.provider
      || existingSession.project_path !== projectPath
      || existingSession.custom_name !== nextName
      || (row.agent !== null && existingSession.agent !== readOptionalString(row.agent))
      || (parentSessionId !== undefined && existingSession.provider_parent_session_id !== parentSessionId)
      || existingSession.updated_at !== normalizedUpdatedAt;
  }

  private readFirstUserText(db: Database.Database, sessionId: string): string | undefined {
    try {
      const row = db.prepare(`
        SELECT p.data AS data
        FROM message m
        INNER JOIN part p
          ON p.session_id = m.session_id
         AND p.message_id = m.id
        WHERE m.session_id = ?
          AND json_extract(m.data, '$.role') = 'user'
          AND json_extract(p.data, '$.type') = 'text'
        ORDER BY COALESCE(m.time_created, 0), COALESCE(p.time_created, 0)
        LIMIT 1
      `).get(sessionId) as { data: string | null } | undefined;

      const data = readJsonRecord(row?.data);
      const text = readOptionalString(data?.text);
      // OpenCode persists the first prompt as a JSON string literal (e.g.
      // `"hello"`), so decode it to avoid titling the session with quotes.
      return text === undefined ? undefined : unwrapJsonStringLiteral(text);
    } catch {
      return undefined;
    }
  }
}
