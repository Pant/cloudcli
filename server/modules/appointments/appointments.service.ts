import { randomUUID } from 'node:crypto';

import type { AppointmentAttachment, AppointmentProviderOptions, AppointmentRecord, AppointmentTriggerType } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type AppointmentsRepository = {
  create(input: Parameters<typeof import('@/modules/database/index.js')['appointmentsDb']['create']>[0]): AppointmentRecord;
  getById(id: string, projectId: string, userId: string | number): AppointmentRecord | null;
  listByProject(projectId: string, userId: string | number): AppointmentRecord[];
  update(id: string, projectId: string, userId: string | number, input: Parameters<typeof import('@/modules/database/index.js')['appointmentsDb']['update']>[3]): AppointmentRecord | null;
  delete(id: string, projectId: string, userId: string | number): boolean;
  reorderMutableQueue(input: { projectId: string; userId: string | number; appointmentIds: string[]; now?: number }): AppointmentRecord[] | null;
};

type AppointmentServiceDependencies = {
  appointments: AppointmentsRepository;
  getProjectById(projectId: string): { project_path: string; isArchived: number } | null;
  getSessionById(sessionId: string): { provider: string; project_path: string | null; isArchived: number } | null;
  now(): number;
  createId(): string;
  dispatchNow(row: AppointmentRecord): Promise<'started' | 'project_busy' | 'session_busy' | 'stale' | 'launch_failed'>;
};

export type AppointmentCreateRequest = {
  sessionId: string; prompt: string; options?: AppointmentProviderOptions;
  attachments?: AppointmentAttachment[]; triggerType: AppointmentTriggerType;
  dueAt?: number | null; timerDurationMs?: number | null; isActive: boolean;
};

function required(value: unknown, name: string): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed) throw new AppError(`${name} is required.`, { code: 'INVALID_APPOINTMENT', statusCode: 400 });
  return parsed;
}

/** Appointments routes delegate ownership checks and scheduling mutations here. */
export function createAppointmentsService(dependencies: AppointmentServiceDependencies) {
  function assertScope(projectId: string, sessionId?: string) {
    const project = dependencies.getProjectById(required(projectId, 'projectId'));
    if (!project || project.isArchived) throw new AppError('Project was not found.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    if (!sessionId) return project;
    const session = dependencies.getSessionById(required(sessionId, 'sessionId'));
    if (!session || session.isArchived) throw new AppError('Session was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    if (!session.project_path || session.project_path !== project.project_path) {
      throw new AppError('Session does not belong to the selected project.', { code: 'SESSION_PROJECT_MISMATCH', statusCode: 400 });
    }
    return { project, session };
  }

  function validateTrigger(input: AppointmentCreateRequest, now: number): void {
    if (!['exact', 'timer', 'project_idle', 'queue'].includes(input.triggerType)) throw new AppError('Invalid appointment trigger.', { code: 'INVALID_TRIGGER', statusCode: 400 });
    if (input.triggerType === 'project_idle' || input.triggerType === 'queue') return;
    if (!Number.isFinite(input.dueAt) || (input.dueAt as number) <= now) throw new AppError('Appointment time must be in the future.', { code: 'INVALID_TRIGGER', statusCode: 400 });
    if (input.triggerType === 'timer' && (!Number.isFinite(input.timerDurationMs) || (input.timerDurationMs as number) <= 0)) {
      throw new AppError('Timer duration must be positive.', { code: 'INVALID_TRIGGER', statusCode: 400 });
    }
  }

  return {
    list(projectId: string, userId: string | number) { assertScope(projectId); return dependencies.appointments.listByProject(projectId, userId); },
    create(projectId: string, userId: string | number, input: AppointmentCreateRequest) {
      const { session } = assertScope(projectId, input.sessionId) as { session: NonNullable<ReturnType<AppointmentServiceDependencies['getSessionById']>> };
      const now = dependencies.now();
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      if (!prompt.trim() && (!Array.isArray(input.attachments) || input.attachments.length === 0)) throw new AppError('Prompt or attachment is required.', { code: 'EMPTY_APPOINTMENT', statusCode: 400 });
      if (typeof input.isActive !== 'boolean') throw new AppError('isActive must be boolean.', { code: 'INVALID_APPOINTMENT', statusCode: 400 });
      validateTrigger(input, now);
      return dependencies.appointments.create({ id: dependencies.createId(), projectId, sessionId: input.sessionId, userId,
        provider: session.provider as Parameters<AppointmentsRepository['create']>[0]['provider'], prompt, options: input.options,
        attachments: input.attachments, triggerType: input.triggerType, dueAt: input.triggerType === 'project_idle' || input.triggerType === 'queue' ? null : input.dueAt,
        timerDurationMs: input.triggerType === 'timer' ? input.timerDurationMs : null, isActive: input.isActive, now });
    },
    reorderQueue(projectId: string, userId: string | number, appointmentIds: string[]) {
      assertScope(projectId);
      if (!Array.isArray(appointmentIds) || appointmentIds.some((id) => typeof id !== 'string' || !id.trim())) {
        throw new AppError('appointmentIds must be an array of appointment IDs.', { code: 'INVALID_APPOINTMENT_QUEUE', statusCode: 400 });
      }
      const reordered = dependencies.appointments.reorderMutableQueue({ projectId, userId, appointmentIds, now: dependencies.now() });
      if (!reordered) throw new AppError('Appointment queue changed or the ordered set is invalid.', { code: 'INVALID_APPOINTMENT_QUEUE', statusCode: 409 });
      return reordered;
    },
    async dispatch(projectId: string, userId: string | number, id: string) {
      assertScope(projectId);
      const current = dependencies.appointments.getById(id, projectId, userId);
      if (!current) throw new AppError('Appointment was not found.', { code: 'APPOINTMENT_NOT_FOUND', statusCode: 404 });
      if (current.triggerType !== 'queue') throw new AppError('Only queue appointments can be dispatched immediately.', { code: 'APPOINTMENT_NOT_QUEUE', statusCode: 409 });
      if (current.status !== 'draft' && current.status !== 'scheduled') throw new AppError('Appointment is no longer available to dispatch.', { code: 'APPOINTMENT_NOT_MUTABLE', statusCode: 409 });
      const result = await dependencies.dispatchNow(current);
      if (result === 'project_busy') throw new AppError('Project already has an active run.', { code: 'APPOINTMENT_PROJECT_BUSY', statusCode: 409 });
      if (result === 'session_busy') throw new AppError('Appointment session is already processing.', { code: 'APPOINTMENT_SESSION_BUSY', statusCode: 409 });
      if (result === 'stale') throw new AppError('Appointment changed before it could be dispatched.', { code: 'APPOINTMENT_DISPATCH_CONFLICT', statusCode: 409 });
      if (result === 'launch_failed') throw new AppError('Appointment launch failed.', { code: 'APPOINTMENT_LAUNCH_FAILED', statusCode: 409 });
      return dependencies.appointments.getById(id, projectId, userId)!;
    },
    toggle(projectId: string, userId: string | number, id: string, isActive: boolean) {
      assertScope(projectId); if (typeof isActive !== 'boolean') throw new AppError('isActive must be boolean.', { code: 'INVALID_APPOINTMENT', statusCode: 400 });
      const current = dependencies.appointments.getById(id, projectId, userId);
      if (!current) throw new AppError('Appointment was not found.', { code: 'APPOINTMENT_NOT_FOUND', statusCode: 404 });
      if (isActive && current.triggerType !== 'project_idle' && current.triggerType !== 'queue' && (!current.dueAt || current.dueAt <= dependencies.now())) throw new AppError('Appointment time must be in the future.', { code: 'INVALID_TRIGGER', statusCode: 400 });
      return dependencies.appointments.update(id, projectId, userId, { isActive, status: isActive ? 'scheduled' : 'draft', projectIdleSince: null, errorMessage: null, now: dependencies.now() })!;
    },
    postpone(projectId: string, userId: string | number, id: string, dueAt: number) {
      assertScope(projectId); if (!Number.isFinite(dueAt) || dueAt <= dependencies.now()) throw new AppError('Appointment time must be in the future.', { code: 'INVALID_TRIGGER', statusCode: 400 });
      if (!dependencies.appointments.getById(id, projectId, userId)) throw new AppError('Appointment was not found.', { code: 'APPOINTMENT_NOT_FOUND', statusCode: 404 });
      return dependencies.appointments.update(id, projectId, userId, { triggerType: 'exact', dueAt, timerDurationMs: null, isActive: true, status: 'scheduled', projectIdleSince: null, errorMessage: null, now: dependencies.now() })!;
    },
    cancel(projectId: string, userId: string | number, id: string) {
      assertScope(projectId); if (!dependencies.appointments.getById(id, projectId, userId)) throw new AppError('Appointment was not found.', { code: 'APPOINTMENT_NOT_FOUND', statusCode: 404 });
      dependencies.appointments.update(id, projectId, userId, { isActive: false, status: 'cancelled', now: dependencies.now() });
      return { id };
    },
  };
}

export const appointmentServiceDefaults = { now: () => Date.now(), createId: () => randomUUID() };
