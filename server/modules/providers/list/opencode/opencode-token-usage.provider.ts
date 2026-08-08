import type Database from 'better-sqlite3';

import { readJsonRecord, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type OpenCodeMessageTokenRow = {
  data: string | null;
};

const readNonNegativeTokenNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : undefined;
};

/**
 * Reads the latest trustworthy assistant current-window count from OpenCode
 * message storage. The REST token service, live runtime, and history provider
 * share this extractor so bookkeeping rows and older schemas behave identically.
 * A positive explicit `tokens.total` wins; otherwise valid present components
 * are summed. Zero-only rows are retained only as a final empty-session fallback
 * after every older assistant row has been checked for meaningful usage and the
 * caller confirms aggregate storage does not prove the session is non-empty.
 */
export function readOpenCodeLatestAssistantWindowTokens(
  database: Database.Database,
  providerSessionId: string,
  allowEmptyZero = true,
): number | undefined {
  try {
    const columns = database.prepare('PRAGMA table_info(message)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has('session_id') || !columnNames.has('data')) {
      return undefined;
    }

    const hasCreatedTime = columnNames.has('time_created');
    const hasId = columnNames.has('id');
    const orderBy = hasCreatedTime && hasId
      ? 'time_created DESC, id DESC'
      : hasCreatedTime
        ? 'time_created DESC, rowid DESC'
        : hasId
          ? 'id DESC'
          : 'rowid DESC';
    const rows = database.prepare(`
      SELECT data
      FROM message
      WHERE session_id = ?
      ORDER BY ${orderBy}
    `).all(providerSessionId) as OpenCodeMessageTokenRow[];

    let hasZeroTokenRecord = false;
    for (const row of rows) {
      const message = readJsonRecord(row.data);
      if (readOptionalString(message?.role) !== 'assistant') {
        continue;
      }

      const tokens = readObjectRecord(message?.tokens);
      if (!tokens) {
        continue;
      }

      const explicitTotal = readNonNegativeTokenNumber(tokens.total);
      if (explicitTotal !== undefined && explicitTotal > 0) {
        return explicitTotal;
      }

      const cache = readObjectRecord(tokens.cache);
      const rawComponents = [
        tokens.input,
        tokens.output,
        tokens.reasoning,
        cache?.read,
        cache?.write,
      ];
      const presentComponents = rawComponents.filter((value) => value !== undefined && value !== null);
      if (presentComponents.length > 0) {
        const components = presentComponents.map(readNonNegativeTokenNumber);
        if (components.every((value): value is number => value !== undefined)) {
          const componentTotal = components.reduce((sum, value) => sum + value, 0);
          if (componentTotal > 0) {
            return componentTotal;
          }
          hasZeroTokenRecord = true;
        }
        continue;
      }

      if (explicitTotal === 0) {
        hasZeroTokenRecord = true;
      }
    }

    return hasZeroTokenRecord && allowEmptyZero ? 0 : undefined;
  } catch {
    // Older OpenCode schemas may omit message storage or expected columns.
    return undefined;
  }
}
