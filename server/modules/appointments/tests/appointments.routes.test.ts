import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { AppError } from '@/shared/utils.js';

import { createAppointmentsRouter } from '../appointments.routes.js';
import { createAppointmentsService } from '../appointments.service.js';

function fakeRepository() {
  const rows: any[] = [];
  return {
    rows,
    create(input: any) { const row = { ...input, userId: String(input.userId), options: input.options ?? {}, attachments: input.attachments ?? [], dueAt: input.dueAt ?? null, timerDurationMs: input.timerDurationMs ?? null, projectIdleSince: null, queuePosition: input.triggerType === 'queue' ? rows.filter((entry) => entry.projectId === input.projectId && entry.userId === String(input.userId) && entry.triggerType === 'queue').length + 1 : null, runGeneration: null, status: input.isActive ? 'scheduled' : 'draft', errorMessage: null, createdAt: input.now, updatedAt: input.now, claimedAt: null, completedAt: null }; rows.push(row); return row; },
    getById(id: string, projectId: string, userId: string | number) { return rows.find((row) => row.id === id && row.projectId === projectId && row.userId === String(userId)) ?? null; },
    listByProject(projectId: string, userId: string | number) { return rows.filter((row) => row.projectId === projectId && row.userId === String(userId)); },
    update(id: string, projectId: string, userId: string | number, input: any) { const row = this.getById(id, projectId, userId); if (!row) return null; Object.assign(row, input); return row; },
    delete() { return false; },
    reorderMutableQueue(input: any) { const mutable = rows.filter((row) => row.projectId === input.projectId && row.userId === String(input.userId) && row.triggerType === 'queue' && ['draft', 'scheduled'].includes(row.status)); if (new Set(input.appointmentIds).size !== input.appointmentIds.length || mutable.length !== input.appointmentIds.length || mutable.some((row) => !input.appointmentIds.includes(row.id))) return null; return input.appointmentIds.map((id: string, index: number) => { const row = mutable.find((entry) => entry.id === id); row.queuePosition = index + 1; return row; }); },
  };
}

async function withServer(run: (url: string) => Promise<void>) {
  const repository = fakeRepository();
  const service = createAppointmentsService({ appointments: repository, getProjectById: (id) => id === 'p1' ? { project_path: '/one', isArchived: 0 } : null, getSessionById: (id) => id === 's1' ? { provider: 'opencode', project_path: '/one', isArchived: 0 } : id === 's2' ? { provider: 'opencode', project_path: '/two', isArchived: 0 } : null, dispatchNow: async (row) => { row.status = 'running'; row.isActive = true; row.runGeneration = 9; return 'started'; }, now: () => 1_000, createId: () => 'a1' });
  const app = express(); app.use(express.json()); app.use((req: Request & { user?: { id: string } }, _res, next) => { req.user = { id: req.header('x-user') ?? '' }; next(); }); app.use('/api/appointments', createAppointmentsRouter(service));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { const appError = error as AppError; res.status(appError.statusCode ?? 500).json({ error: appError.code ?? 'INTERNAL_ERROR' }); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { const address = server.address() as AddressInfo; await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('authenticated project-scoped create, list, toggle and cancel return normalized responses', async () => withServer(async (url) => {
  const create = await fetch(`${url}/api/appointments/p1`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'u1' }, body: JSON.stringify({ sessionId: 's1', prompt: '/literal', triggerType: 'exact', dueAt: 2_000, isActive: true }) });
  assert.equal(create.status, 201); assert.equal((await create.json() as any).data.prompt, '/literal');
  const list = await fetch(`${url}/api/appointments/p1`, { headers: { 'x-user': 'u1' } }); assert.equal((await list.json() as any).data.length, 1);
  const other = await fetch(`${url}/api/appointments/p1`, { headers: { 'x-user': 'u2' } }); assert.equal((await other.json() as any).data.length, 0);
  const draft = await fetch(`${url}/api/appointments/p1/a1/active`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-user': 'u1' }, body: JSON.stringify({ isActive: false }) }); assert.equal((await draft.json() as any).data.status, 'draft');
  const cancel = await fetch(`${url}/api/appointments/p1/a1`, { method: 'DELETE', headers: { 'x-user': 'u1' } }); assert.equal(cancel.status, 200);
}));

test('routes reject missing auth, project/session mismatch and past triggers', async () => withServer(async (url) => {
  assert.equal((await fetch(`${url}/api/appointments/p1`)).status, 401);
  const mismatch = await fetch(`${url}/api/appointments/p1`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'u1' }, body: JSON.stringify({ sessionId: 's2', prompt: 'x', triggerType: 'exact', dueAt: 2_000, isActive: true }) }); assert.equal(mismatch.status, 400);
  const past = await fetch(`${url}/api/appointments/p1`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'u1' }, body: JSON.stringify({ sessionId: 's1', prompt: 'x', triggerType: 'timer', dueAt: 500, timerDurationMs: -1, isActive: true }) }); assert.equal(past.status, 400);
}));

test('queue appointments accept active or draft creation and reorder the exact scoped mutable pipeline', async () => withServer(async (url) => {
  const headers = { 'content-type': 'application/json', 'x-user': 'u1' };
  const first = await fetch(`${url}/api/appointments/p1`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1', prompt: 'one', triggerType: 'queue', isActive: true }) });
  assert.equal(first.status, 201); assert.equal((await first.json() as any).data.queuePosition, 1);
  const second = await fetch(`${url}/api/appointments/p1`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1', prompt: 'two', triggerType: 'queue', isActive: false }) });
  assert.equal(second.status, 201);
  const reordered = await fetch(`${url}/api/appointments/p1/queue`, { method: 'PUT', headers, body: JSON.stringify({ appointmentIds: ['a1', 'a1'] }) });
  assert.equal(reordered.status, 409);
  const foreignUser = await fetch(`${url}/api/appointments/p1/queue`, { method: 'PUT', headers: { ...headers, 'x-user': 'u2' }, body: JSON.stringify({ appointmentIds: ['a1'] }) });
  assert.equal(foreignUser.status, 409);
}));
test('dispatch launches an owned mutable queue row and rejects foreign, non-queue, and terminal rows', async () => withServer(async (url) => {
  const headers = { 'content-type': 'application/json', 'x-user': 'u1' };
  await fetch(`${url}/api/appointments/p1`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1', prompt: 'queue', triggerType: 'queue', isActive: false }) });
  const dispatched = await fetch(`${url}/api/appointments/p1/a1/dispatch`, { method: 'POST', headers });
  assert.equal(dispatched.status, 200); assert.equal((await dispatched.json() as any).data.runGeneration, 9);
  assert.equal((await fetch(`${url}/api/appointments/p1/a1/dispatch`, { method: 'POST', headers })).status, 409);
  assert.equal((await fetch(`${url}/api/appointments/p1/a1/dispatch`, { method: 'POST', headers: { ...headers, 'x-user': 'u2' } })).status, 404);
}));
