import { getConnection } from '@/modules/database/connection.js';
import type {
  AppendSessionRunHistoryInput,
  BeginSessionRunInput,
  LLMProvider,
  SessionContinuationOptions,
  SessionRunLifecycleState,
  SessionRunHistoryRecord,
  SessionRunStateRecord,
  SessionRunTerminalReason,
  SessionRunTerminalUpdate,
} from '@/shared/types.js';

type RunStateRow = {
  session_id: string;
  provider: LLMProvider;
  generation: number;
  desired_state: 'running' | 'stopped';
  lifecycle_state: SessionRunLifecycleState;
  terminal_reason: SessionRunTerminalReason | null;
  terminal_message: string | null;
  exit_code: number | null;
  restart_count: number;
  continuation_options_json: string;
  started_at: number;
  last_progress_at: number;
  terminal_at: number | null;
  next_recovery_at: number | null;
  updated_at: number;
};

type RunHistoryRow = {
  session_id: string; generation: number; provider: LLMProvider; started_at: number;
  terminal_at: number; lifecycle_state: SessionRunHistoryRecord['lifecycleState'];
  terminal_reason: SessionRunTerminalReason; terminal_message: string | null;
  exit_code: number | null; signal: NodeJS.Signals | null; artifact_run_id: string | null;
  artifact_relative_path: string | null; stderr_tail: string; resources_json: string | null;
};

const SAFE_OPTION_KEYS = ['model', 'effort', 'agent', 'permissionMode', 'projectPath', 'cwd'] as const;
const CURRENT_COLUMNS = 'session_id, provider, generation, desired_state, lifecycle_state, terminal_reason, terminal_message, exit_code, restart_count, continuation_options_json, started_at, last_progress_at, terminal_at, next_recovery_at, updated_at';
const HISTORY_COLUMNS = 'session_id, generation, provider, started_at, terminal_at, lifecycle_state, terminal_reason, terminal_message, exit_code, signal, artifact_run_id, artifact_relative_path, stderr_tail, resources_json';
const SIGNALS = new Set<NodeJS.Signals>(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO', 'SIGPOLL', 'SIGPWR', 'SIGSYS']);
const RESOURCE_FIELDS = ['memoryCurrentBytes', 'memoryPeakBytes'] as const;
const RESOURCE_MAP_FIELDS = ['memoryEvents', 'memoryStat'] as const;

function boundedText(value: unknown, maxCharacters: number, maxBytes: number): string | null {
  if (typeof value !== 'string') return null;
  let result = value.slice(0, maxCharacters);
  while (Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(0, -1);
  return result;
}

function sanitizeDiagnostic(value: unknown): { runId: string; relativePath: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const runId = boundedText(source.runId, 128, 128);
  const relativePath = boundedText(source.relativePath, 512, 512);
  if (!runId || !relativePath || pathIsUnsafe(runId) || pathIsUnsafe(relativePath)) return null;
  return { runId, relativePath: relativePath.replaceAll('\\', '/') };
}

function pathIsUnsafe(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').some((part) => part === '..' || part === '');
}

function sanitizeSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.scope !== 'container-cgroup-v2' || !Number.isSafeInteger(source.capturedAt) || (source.capturedAt as number) < 0) return null;
  const result: Record<string, unknown> = { scope: source.scope, capturedAt: source.capturedAt };
  for (const field of RESOURCE_FIELDS) {
    const number = source[field];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) result[field] = number;
  }
  for (const field of RESOURCE_MAP_FIELDS) {
    const map = source[field];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    const sanitized: Record<string, number> = {};
    for (const [key, number] of Object.entries(map).slice(0, 64)) {
      if (/^[A-Za-z0-9_.-]{1,64}$/.test(key) && typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) sanitized[key] = number;
    }
    if (Object.keys(sanitized).length) result[field] = sanitized;
  }
  return result;
}

function sanitizeResources(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const resources: Record<string, unknown> = {};
  for (const phase of ['start', 'end'] as const) {
    const snapshot = sanitizeSnapshot(source[phase]);
    if (snapshot) resources[phase] = snapshot;
  }
  if (!Object.keys(resources).length) return null;
  const json = JSON.stringify(resources);
  return Buffer.byteLength(json, 'utf8') <= 16_384 ? json : null;
}

function toHistoryRecord(row: RunHistoryRow): SessionRunHistoryRecord {
  let resources: SessionRunHistoryRecord['resources'] = null;
  try { resources = row.resources_json ? JSON.parse(row.resources_json) : null; } catch { resources = null; }
  return { sessionId: row.session_id, generation: row.generation, provider: row.provider,
    startedAt: row.started_at, terminalAt: row.terminal_at, lifecycleState: row.lifecycle_state,
    terminalReason: row.terminal_reason, terminalMessage: row.terminal_message, exitCode: row.exit_code,
    signal: row.signal, diagnostic: row.artifact_run_id && row.artifact_relative_path ? { runId: row.artifact_run_id, relativePath: row.artifact_relative_path } : null,
    stderrTail: row.stderr_tail, resources };
}

function sanitizeContinuationOptions(value: unknown): SessionContinuationOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const sanitized: Record<string, string> = {};
  for (const key of SAFE_OPTION_KEYS) {
    const option = source[key];
    if (typeof option === 'string' && option.trim()) sanitized[key] = option;
  }
  return sanitized;
}

function toRecord(row: RunStateRow | undefined): SessionRunStateRecord | null {
  if (!row) return null;
  let parsed: unknown = {};
  try { parsed = JSON.parse(row.continuation_options_json); } catch { parsed = {}; }
  return {
    sessionId: row.session_id,
    provider: row.provider,
    generation: row.generation,
    desiredState: row.desired_state,
    lifecycleState: row.lifecycle_state,
    terminalReason: row.terminal_reason,
    terminalMessage: row.terminal_message,
    exitCode: row.exit_code,
    restartCount: row.restart_count,
    continuationOptions: sanitizeContinuationOptions(parsed),
    startedAt: row.started_at,
    lastProgressAt: row.last_progress_at,
    terminalAt: row.terminal_at,
    nextRecoveryAt: row.next_recovery_at,
    updatedAt: row.updated_at,
  };
}

function getById(sessionId: string): SessionRunStateRecord | null {
  const row = getConnection().prepare(`SELECT ${CURRENT_COLUMNS} FROM session_run_state WHERE session_id = ?`).get(sessionId) as RunStateRow | undefined;
  return toRecord(row);
}

/**
 * Durable run-state repository consumed through the Database barrel by
 * WebSocket lifecycle orchestration and provider lifecycle status services.
 */
export const sessionRunStateDb = {
  getById,

  beginRun(input: BeginSessionRunInput): SessionRunStateRecord {
    const db = getConnection();
    const now = input.now ?? Date.now();
    const optionsJson = JSON.stringify(sanitizeContinuationOptions(input.continuationOptions));
    db.prepare(`
      INSERT INTO session_run_state (${CURRENT_COLUMNS})
      VALUES (?, ?, 1, 'running', 'running', NULL, NULL, NULL, 0, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider, generation = session_run_state.generation + 1,
        desired_state = 'running', lifecycle_state = 'running', terminal_reason = NULL,
        terminal_message = NULL, exit_code = NULL, restart_count = 0,
        continuation_options_json = excluded.continuation_options_json,
        started_at = excluded.started_at, last_progress_at = excluded.last_progress_at,
        terminal_at = NULL, next_recovery_at = NULL, updated_at = excluded.updated_at
    `).run(input.sessionId, input.provider, optionsJson, now, now, now);
    return getById(input.sessionId)!;
  },

  recordProgress(sessionId: string, generation: number, now = Date.now()): boolean {
    return getConnection().prepare(`UPDATE session_run_state SET lifecycle_state = 'running', last_progress_at = ?, updated_at = ? WHERE session_id = ? AND generation = ? AND desired_state = 'running'`).run(now, now, sessionId, generation).changes > 0;
  },

  requestManualStop(sessionId: string, generation: number, now = Date.now()): boolean {
    return getConnection().prepare(`UPDATE session_run_state SET desired_state = 'stopped', lifecycle_state = 'manually_stopped', terminal_reason = 'manual_stop', terminal_at = ?, next_recovery_at = NULL, updated_at = ? WHERE session_id = ? AND generation = ?`).run(now, now, sessionId, generation).changes > 0;
  },

  recordTerminal(sessionId: string, generation: number, update: SessionRunTerminalUpdate): boolean {
    const now = update.now ?? Date.now();
    const desiredState = update.lifecycleState === 'completed' ? 'stopped' : 'running';
    return getConnection().prepare(`UPDATE session_run_state SET desired_state = ?, lifecycle_state = ?, terminal_reason = ?, terminal_message = ?, exit_code = ?, terminal_at = ?, next_recovery_at = NULL, updated_at = ? WHERE session_id = ? AND generation = ? AND lifecycle_state <> 'manually_stopped'`).run(desiredState, update.lifecycleState, update.terminalReason, update.terminalMessage ?? null, update.exitCode ?? null, now, now, sessionId, generation).changes > 0;
  },

  appendHistory(input: AppendSessionRunHistoryInput): boolean {
    const diagnostic = sanitizeDiagnostic(input.diagnostic);
    const signal = typeof input.signal === 'string' && input.signal.length <= 16 && SIGNALS.has(input.signal as NodeJS.Signals) ? input.signal : null;
    const terminalMessage = boundedText(input.terminalMessage, 2_000, 8_000);
    const stderrTail = boundedText(input.stderrTail, 16_000, 64_000) ?? '';
    const exitCode = typeof input.exitCode === 'number' && Number.isSafeInteger(input.exitCode) && input.exitCode >= -1 && input.exitCode <= 255 ? input.exitCode : null;
    const result = getConnection().prepare(`
      INSERT OR IGNORE INTO session_run_history (${HISTORY_COLUMNS})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM session_run_state WHERE session_id = ? AND generation = ? AND provider = ?)
    `).run(input.sessionId, input.generation, input.provider, input.startedAt, input.terminalAt,
      input.lifecycleState, input.terminalReason, terminalMessage, exitCode, signal,
      diagnostic?.runId ?? null, diagnostic?.relativePath ?? null, stderrTail,
      sanitizeResources(input.resources), input.sessionId, input.generation, input.provider);
    return result.changes > 0;
  },

  listRecentHistory(limit = 100, sessionId?: string): SessionRunHistoryRecord[] {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const rows = sessionId
      ? getConnection().prepare(`SELECT ${HISTORY_COLUMNS} FROM session_run_history WHERE session_id = ? ORDER BY terminal_at DESC, generation DESC, session_id LIMIT ?`).all(sessionId, boundedLimit)
      : getConnection().prepare(`SELECT ${HISTORY_COLUMNS} FROM session_run_history ORDER BY terminal_at DESC, session_id, generation DESC LIMIT ?`).all(boundedLimit);
    return (rows as RunHistoryRow[]).map(toHistoryRecord);
  },

  pruneHistory(retainCount: number): number {
    const retain = Math.max(0, Math.min(10_000, Math.trunc(retainCount)));
    return getConnection().prepare(`
      DELETE FROM session_run_history WHERE (session_id, generation) IN (
        SELECT history.session_id, history.generation FROM session_run_history history
        LEFT JOIN session_run_state current ON current.session_id = history.session_id AND current.generation = history.generation
        WHERE current.session_id IS NULL
        ORDER BY history.terminal_at DESC, history.session_id, history.generation DESC
        LIMIT -1 OFFSET ?
      )
    `).run(retain).changes;
  },

  markStalled(sessionId: string, generation: number, terminalMessage: string | null, nextRecoveryAt: number, now = Date.now()): boolean {
    return getConnection().prepare(`UPDATE session_run_state SET lifecycle_state = 'stalled', terminal_reason = 'stalled', terminal_message = ?, next_recovery_at = ?, updated_at = ? WHERE session_id = ? AND generation = ? AND desired_state = 'running'`).run(terminalMessage, nextRecoveryAt, now, sessionId, generation).changes > 0;
  },

  /** WebSocket startup reconciliation uses this bounded list to inspect only interrupted run states. */
  listStartupReconciliationCandidates(limit = 200): SessionRunStateRecord[] {
    const rows = getConnection().prepare(`SELECT ${CURRENT_COLUMNS} FROM session_run_state WHERE desired_state = 'running' AND lifecycle_state IN ('running', 'recovering') ORDER BY updated_at DESC, session_id LIMIT ?`).all(Math.max(1, limit)) as RunStateRow[];
    return rows.map((row) => toRecord(row)!);
  },

  /** WebSocket startup reconciliation generation-fences the one-way interrupted-to-stalled transition. */
  markStartupInterrupted(sessionId: string, generation: number, terminalMessage: string, now = Date.now()): boolean {
    return getConnection().prepare(`UPDATE session_run_state SET lifecycle_state = 'stalled', terminal_reason = 'stalled', terminal_message = ?, terminal_at = ?, next_recovery_at = NULL, updated_at = ? WHERE session_id = ? AND generation = ? AND desired_state = 'running' AND lifecycle_state IN ('running', 'recovering')`).run(terminalMessage, now, now, sessionId, generation).changes > 0;
  },

  claimRecovery(sessionId: string, generation: number, maxAttempts: number, now = Date.now()): SessionRunStateRecord | null {
    const db = getConnection();
    const claimed = db.prepare(`UPDATE session_run_state SET generation = generation + 1, lifecycle_state = 'recovering', terminal_reason = NULL, terminal_message = NULL, exit_code = NULL, restart_count = restart_count + 1, started_at = ?, last_progress_at = ?, terminal_at = NULL, next_recovery_at = NULL, updated_at = ? WHERE session_id = ? AND generation = ? AND desired_state = 'running' AND lifecycle_state IN ('stalled', 'failed', 'exited') AND restart_count < ? AND (next_recovery_at IS NULL OR next_recovery_at <= ?)`)
      .run(now, now, now, sessionId, generation, Math.max(0, maxAttempts), now);
    return claimed.changes > 0 ? getById(sessionId) : null;
  },

  markRecoveryExhausted(sessionId: string, generation: number, terminalMessage: string | null, now = Date.now()): boolean {
    return getConnection().prepare(`UPDATE session_run_state SET lifecycle_state = 'recovery_exhausted', terminal_reason = 'recovery_exhausted', terminal_message = ?, terminal_at = ?, next_recovery_at = NULL, updated_at = ? WHERE session_id = ? AND generation = ? AND desired_state = 'running' AND lifecycle_state <> 'manually_stopped'`).run(terminalMessage, now, now, sessionId, generation).changes > 0;
  },

  listRecoverable(now = Date.now(), limit = 100): SessionRunStateRecord[] {
    const rows = getConnection().prepare(`SELECT ${CURRENT_COLUMNS} FROM session_run_state WHERE desired_state = 'running' AND lifecycle_state IN ('stalled', 'failed', 'exited') AND (next_recovery_at IS NULL OR next_recovery_at <= ?) ORDER BY COALESCE(next_recovery_at, updated_at), session_id LIMIT ?`).all(now, Math.max(1, limit)) as RunStateRow[];
    return rows.map((row) => toRecord(row)!);
  },

  listActionable(limit = 200): SessionRunStateRecord[] {
    const rows = getConnection().prepare(`SELECT ${CURRENT_COLUMNS} FROM session_run_state WHERE lifecycle_state <> 'completed' ORDER BY updated_at DESC, session_id LIMIT ?`).all(Math.max(1, limit)) as RunStateRow[];
    return rows.map((row) => toRecord(row)!);
  },
};
