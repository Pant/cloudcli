import { getConnection } from '@/modules/database/connection.js';

export type MutationReceiptResult = { httpStatus: number; payload: Record<string, unknown> };
export type MutationReceiptClaim =
  | { kind: 'claimed' }
  | { kind: 'in_progress' }
  | { kind: 'fingerprint_conflict' }
  | { kind: 'completed'; result: MutationReceiptResult };

type ReceiptRow = {
  request_fingerprint: string;
  status: 'in_progress' | 'completed';
  http_status: number | null;
  result_json: string | null;
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ROWS = 10_000;

/** Durable mutation receipt repository consumed by Providers through the Database barrel. */
export const mutationReceiptsDb = {
  claim(input: { scope: string; operation: string; key: string; fingerprint: string; now?: number; ttlMs?: number }): MutationReceiptClaim {
    const db = getConnection();
    const now = input.now ?? Date.now();
    return db.transaction((): MutationReceiptClaim => {
      db.prepare('DELETE FROM mutation_receipts WHERE expires_at <= ? LIMIT 100').run(now);
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO mutation_receipts
          (scope, operation, idempotency_key, request_fingerprint, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'in_progress', ?, ?)
      `).run(input.scope, input.operation, input.key, input.fingerprint, now, now + (input.ttlMs ?? DEFAULT_TTL_MS));
      if (inserted.changes > 0) return { kind: 'claimed' };
      const row = db.prepare(`SELECT request_fingerprint, status, http_status, result_json
        FROM mutation_receipts WHERE scope = ? AND operation = ? AND idempotency_key = ?`)
        .get(input.scope, input.operation, input.key) as ReceiptRow;
      if (row.request_fingerprint !== input.fingerprint) return { kind: 'fingerprint_conflict' };
      if (row.status === 'in_progress') return { kind: 'in_progress' };
      return { kind: 'completed', result: { httpStatus: row.http_status!, payload: JSON.parse(row.result_json!) as Record<string, unknown> } };
    })();
  },

  complete(input: { scope: string; operation: string; key: string; fingerprint: string; result: MutationReceiptResult }): boolean {
    return getConnection().prepare(`UPDATE mutation_receipts SET status = 'completed', http_status = ?, result_json = ?
      WHERE scope = ? AND operation = ? AND idempotency_key = ? AND request_fingerprint = ? AND status = 'in_progress'`)
      .run(input.result.httpStatus, JSON.stringify(input.result.payload), input.scope, input.operation, input.key, input.fingerprint).changes > 0;
  },

  abandon(input: { scope: string; operation: string; key: string; fingerprint: string }): boolean {
    return getConnection().prepare(`DELETE FROM mutation_receipts
      WHERE scope = ? AND operation = ? AND idempotency_key = ? AND request_fingerprint = ? AND status = 'in_progress'`)
      .run(input.scope, input.operation, input.key, input.fingerprint).changes > 0;
  },

  cleanup(options: { now?: number; maxRows?: number; deleteLimit?: number } = {}): number {
    const db = getConnection();
    const now = options.now ?? Date.now();
    const maxRows = Math.max(0, Math.min(100_000, options.maxRows ?? DEFAULT_MAX_ROWS));
    const limit = Math.max(1, Math.min(1_000, options.deleteLimit ?? 100));
    return db.transaction(() => {
      let removed = db.prepare('DELETE FROM mutation_receipts WHERE rowid IN (SELECT rowid FROM mutation_receipts WHERE expires_at <= ? ORDER BY expires_at, created_at LIMIT ?)').run(now, limit).changes;
      const remaining = limit - removed;
      if (remaining > 0) removed += db.prepare(`DELETE FROM mutation_receipts WHERE rowid IN (
        SELECT rowid FROM mutation_receipts ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      ) LIMIT ?`).run(maxRows, remaining).changes;
      return removed;
    })();
  },
};
