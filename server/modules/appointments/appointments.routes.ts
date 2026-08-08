import express, { type Request } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import type { AppointmentCreateRequest } from './appointments.service.js';

type AppointmentsService = ReturnType<typeof import('./appointments.service.js')['createAppointmentsService']>;
type AuthenticatedRequest = Request & { user?: { id?: string | number; userId?: string | number } };

function userId(req: AuthenticatedRequest): string | number {
  const value = req.user?.id ?? req.user?.userId;
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim().length === 0) throw new AppError('Authentication required.', { code: 'AUTH_REQUIRED', statusCode: 401 });
  return value;
}
function projectId(req: Request): string {
  const value = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
  if (!value) throw new AppError('projectId is required.', { code: 'PROJECT_ID_REQUIRED', statusCode: 400 });
  return value;
}
function appointmentId(req: Request): string {
  const value = typeof req.params.appointmentId === 'string' ? req.params.appointmentId.trim() : '';
  if (!value) throw new AppError('appointmentId is required.', { code: 'APPOINTMENT_ID_REQUIRED', statusCode: 400 });
  return value;
}

/** Server entrypoint mounts this authenticated, project-scoped transport router. */
export function createAppointmentsRouter(service: AppointmentsService): express.Router {
  const router = express.Router();
  router.get('/:projectId', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(service.list(projectId(req), userId(req))))));
  router.post('/:projectId', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: AppointmentCreateRequest = { sessionId: body.sessionId as string, prompt: body.prompt as string, options: body.options as AppointmentCreateRequest['options'], attachments: body.attachments as AppointmentCreateRequest['attachments'], triggerType: body.triggerType as AppointmentCreateRequest['triggerType'], dueAt: body.dueAt as number, timerDurationMs: body.timerDurationMs as number, isActive: body.isActive as boolean };
    res.status(201).json(createApiSuccessResponse(service.create(projectId(req), userId(req), input)));
  }));
  router.put('/:projectId/queue', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(createApiSuccessResponse(service.reorderQueue(projectId(req), userId(req), body.appointmentIds as string[])));
  }));
  router.post('/:projectId/:appointmentId/dispatch', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(await service.dispatch(projectId(req), userId(req), appointmentId(req))))));
  router.patch('/:projectId/:appointmentId/active', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(service.toggle(projectId(req), userId(req), appointmentId(req), req.body?.isActive)))));
  router.patch('/:projectId/:appointmentId/postpone', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(service.postpone(projectId(req), userId(req), appointmentId(req), req.body?.dueAt)))));
  router.delete('/:projectId/:appointmentId', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(service.cancel(projectId(req), userId(req), appointmentId(req))))));
  return router;
}
