import { getConnection } from '@/modules/database/connection.js';
import type {
  AppointmentAttachment,
  AppointmentProviderOptions,
  AppointmentRecord,
  AppointmentStatus,
  AppointmentTriggerType,
  CreateAppointmentInput,
  LLMProvider,
  ReorderAppointmentQueueInput,
  UpdateAppointmentInput,
} from '@/shared/types.js';

type AppointmentRow = {
  id: string; project_id: string; session_id: string; user_id: string; provider: LLMProvider;
  prompt: string; options_json: string; attachments_json: string; trigger_type: AppointmentTriggerType;
  due_at: number | null; timer_duration_ms: number | null; project_idle_since: number | null;
  queue_position: number | null; run_generation: number | null;
  is_active: number; status: AppointmentStatus; error_message: string | null; created_at: number;
  updated_at: number; claimed_at: number | null; completed_at: number | null;
};

const COLUMNS = 'id, project_id, session_id, user_id, provider, prompt, options_json, attachments_json, trigger_type, due_at, timer_duration_ms, project_idle_since, queue_position, run_generation, is_active, status, error_message, created_at, updated_at, claimed_at, completed_at';

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function toRecord(row: AppointmentRow | undefined): AppointmentRecord | null {
  if (!row) return null;
  return {
    id: row.id, projectId: row.project_id, sessionId: row.session_id, userId: row.user_id,
    provider: row.provider, prompt: row.prompt,
    options: parseJson<AppointmentProviderOptions>(row.options_json, {}),
    attachments: parseJson<AppointmentAttachment[]>(row.attachments_json, []),
    triggerType: row.trigger_type, dueAt: row.due_at, timerDurationMs: row.timer_duration_ms,
    projectIdleSince: row.project_idle_since, isActive: row.is_active === 1, status: row.status,
    queuePosition: row.queue_position, runGeneration: row.run_generation,
    errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at,
    claimedAt: row.claimed_at, completedAt: row.completed_at,
  };
}

function getById(id: string, projectId: string, userId: string | number): AppointmentRecord | null {
  const row = getConnection().prepare(`SELECT ${COLUMNS} FROM appointments WHERE id = ? AND project_id = ? AND user_id = ?`).get(id, projectId, String(userId)) as AppointmentRow | undefined;
  return toRecord(row);
}

/** Durable scheduling repository consumed by the Appointments service through the Database barrel. */
export const appointmentsDb = {
  create(input: CreateAppointmentInput): AppointmentRecord {
    const now = input.now ?? Date.now();
    const status: AppointmentStatus = input.isActive ? 'scheduled' : 'draft';
    const db = getConnection();
    db.transaction(() => {
      const queuePosition = input.triggerType === 'queue'
        ? (db.prepare("SELECT COALESCE(MAX(queue_position), 0) + 1 AS position FROM appointments WHERE project_id = ? AND user_id = ? AND trigger_type = 'queue' AND status NOT IN ('completed', 'failed', 'cancelled')").get(input.projectId, String(input.userId)) as { position: number }).position
        : null;
      db.prepare(`INSERT INTO appointments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?, ?, NULL, NULL)`).run(
        input.id, input.projectId, input.sessionId, String(input.userId), input.provider, input.prompt,
        JSON.stringify(input.options ?? {}), JSON.stringify(input.attachments ?? []), input.triggerType,
        input.dueAt ?? null, input.timerDurationMs ?? null, queuePosition, input.isActive ? 1 : 0, status, now, now,
      );
    })();
    return getById(input.id, input.projectId, input.userId)!;
  },
  getById,
  listByProject(projectId: string, userId: string | number): AppointmentRecord[] {
    const rows = getConnection().prepare(`SELECT ${COLUMNS} FROM appointments WHERE project_id = ? AND user_id = ? ORDER BY CASE WHEN trigger_type = 'queue' AND status NOT IN ('completed', 'failed', 'cancelled') THEN 0 ELSE 1 END, CASE WHEN trigger_type = 'queue' THEN queue_position END, CASE WHEN trigger_type = 'queue' THEN created_at END, CASE WHEN trigger_type = 'queue' THEN id END, created_at DESC, id`).all(projectId, String(userId)) as AppointmentRow[];
    return rows.map((row) => toRecord(row)!);
  },
  update(id: string, projectId: string, userId: string | number, input: UpdateAppointmentInput): AppointmentRecord | null {
    const current = getById(id, projectId, userId);
    if (!current) return null;
    const now = input.now ?? Date.now();
    const isActive = input.isActive ?? current.isActive;
    const status = input.status ?? (input.isActive === undefined ? current.status : (isActive ? 'scheduled' : 'draft'));
    getConnection().prepare(`UPDATE appointments SET trigger_type = ?, due_at = ?, timer_duration_ms = ?, project_idle_since = ?, is_active = ?, status = ?, error_message = ?, updated_at = ? WHERE id = ? AND project_id = ? AND user_id = ?`).run(
      input.triggerType ?? current.triggerType, input.dueAt === undefined ? current.dueAt : input.dueAt,
      input.timerDurationMs === undefined ? current.timerDurationMs : input.timerDurationMs,
      input.projectIdleSince === undefined ? current.projectIdleSince : input.projectIdleSince,
      isActive ? 1 : 0, status, input.errorMessage === undefined ? current.errorMessage : input.errorMessage,
      now, id, projectId, String(userId),
    );
    return getById(id, projectId, userId);
  },
  delete(id: string, projectId: string, userId: string | number): boolean {
    return getConnection().prepare('DELETE FROM appointments WHERE id = ? AND project_id = ? AND user_id = ?').run(id, projectId, String(userId)).changes > 0;
  },
  transition(id: string, expectedStatus: AppointmentStatus, nextStatus: AppointmentStatus, now = Date.now(), errorMessage: string | null = null): boolean {
    const terminal = nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'cancelled';
    return getConnection().prepare(`UPDATE appointments SET status = ?, is_active = CASE WHEN ? THEN 0 ELSE is_active END, error_message = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ? WHERE id = ? AND status = ?`).run(nextStatus, terminal ? 1 : 0, errorMessage, terminal ? 1 : 0, now, now, id, expectedStatus).changes > 0;
  },
  claim(id: string, now = Date.now()): AppointmentRecord | null {
    const changed = getConnection().prepare("UPDATE appointments SET status = 'running', claimed_at = ?, updated_at = ? WHERE id = ? AND is_active = 1 AND status = 'scheduled'").run(now, now, id);
    if (changed.changes === 0) return null;
    const row = getConnection().prepare(`SELECT ${COLUMNS} FROM appointments WHERE id = ?`).get(id) as AppointmentRow;
    return toRecord(row);
  },
  activateDraftForDispatch(id: string, projectId: string, userId: string | number, now = Date.now()): AppointmentRecord | null {
    const changed = getConnection().prepare("UPDATE appointments SET is_active = 1, status = 'scheduled', error_message = NULL, updated_at = ? WHERE id = ? AND project_id = ? AND user_id = ? AND trigger_type = 'queue' AND is_active = 0 AND status = 'draft'").run(now, id, projectId, String(userId));
    return changed.changes === 1 ? getById(id, projectId, userId) : null;
  },
  assignRunGeneration(id: string, generation: number, now = Date.now()): boolean {
    return getConnection().prepare("UPDATE appointments SET run_generation = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(generation, now, id).changes > 0;
  },
  listRunning(): AppointmentRecord[] {
    return (getConnection().prepare(`SELECT ${COLUMNS} FROM appointments WHERE status = 'running' ORDER BY claimed_at, id`).all() as AppointmentRow[]).map((row) => toRecord(row)!);
  },
  listMutableQueue(projectId: string, userId: string | number): AppointmentRecord[] {
    return (getConnection().prepare(`SELECT ${COLUMNS} FROM appointments WHERE project_id = ? AND user_id = ? AND trigger_type = 'queue' AND status IN ('draft', 'scheduled') ORDER BY queue_position, created_at, id`).all(projectId, String(userId)) as AppointmentRow[]).map((row) => toRecord(row)!);
  },
  reorderMutableQueue(input: ReorderAppointmentQueueInput): AppointmentRecord[] | null {
    const db = getConnection();
    return db.transaction(() => {
      if (new Set(input.appointmentIds).size !== input.appointmentIds.length) return null;
      const current = appointmentsDb.listMutableQueue(input.projectId, input.userId);
      if (current.length !== input.appointmentIds.length || current.some(({ id }) => !input.appointmentIds.includes(id))) return null;
      const update = db.prepare("UPDATE appointments SET queue_position = ?, updated_at = ? WHERE id = ? AND project_id = ? AND user_id = ? AND trigger_type = 'queue' AND status IN ('draft', 'scheduled')");
      const now = input.now ?? Date.now();
      for (const [index, id] of input.appointmentIds.entries()) {
        if (update.run(index + 1, now, id, input.projectId, String(input.userId)).changes !== 1) throw new Error('Appointment queue changed during reorder');
      }
      return appointmentsDb.listMutableQueue(input.projectId, input.userId);
    })();
  },
  listNextQueued(limit = 100): AppointmentRecord[] {
    const rows = getConnection().prepare(`SELECT ${COLUMNS} FROM appointments a WHERE is_active = 1 AND status = 'scheduled' AND trigger_type = 'queue' AND NOT EXISTS (SELECT 1 FROM appointments earlier WHERE earlier.project_id = a.project_id AND earlier.user_id = a.user_id AND earlier.trigger_type = 'queue' AND earlier.status = 'scheduled' AND earlier.is_active = 1 AND (earlier.queue_position < a.queue_position OR (earlier.queue_position = a.queue_position AND (earlier.created_at < a.created_at OR (earlier.created_at = a.created_at AND earlier.id < a.id))))) AND NOT EXISTS (SELECT 1 FROM appointments running WHERE running.project_id = a.project_id AND running.trigger_type = 'queue' AND running.status = 'running') ORDER BY queue_position, created_at, id LIMIT ?`).all(Math.max(1, limit)) as AppointmentRow[];
    return rows.map((row) => toRecord(row)!);
  },
  listDue(now = Date.now(), limit = 100): AppointmentRecord[] {
    const rows = getConnection().prepare(`SELECT ${COLUMNS} FROM appointments WHERE is_active = 1 AND status = 'scheduled' AND trigger_type IN ('exact', 'timer') AND due_at <= ? ORDER BY due_at, id LIMIT ?`).all(now, Math.max(1, limit)) as AppointmentRow[];
    return rows.map((row) => toRecord(row)!);
  },
  listProjectIdle(limit = 100): AppointmentRecord[] {
    const rows = getConnection().prepare(`SELECT ${COLUMNS} FROM appointments WHERE is_active = 1 AND status = 'scheduled' AND trigger_type = 'project_idle' ORDER BY created_at, id LIMIT ?`).all(Math.max(1, limit)) as AppointmentRow[];
    return rows.map((row) => toRecord(row)!);
  },
  markActiveProjectIdleNeedsReview(now = Date.now()): number {
    return getConnection().prepare("UPDATE appointments SET status = 'needs_review', project_idle_since = NULL, updated_at = ? WHERE is_active = 1 AND status = 'scheduled' AND trigger_type = 'project_idle'").run(now).changes;
  },
};
