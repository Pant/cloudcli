import { appointmentsDb, projectsDb, sessionRunStateDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunLifecycleService, chatRunRegistry } from '@/modules/websocket/index.js';

import { createAppointmentScheduler } from './appointment-scheduler.service.js';
import { createAppointmentsRouter } from './appointments.routes.js';
import { appointmentServiceDefaults, createAppointmentsService } from './appointments.service.js';

export const appointmentScheduler = createAppointmentScheduler({ appointments: appointmentsDb, getSessionById: (id) => sessionsDb.getSessionById(id), getRunState: (id) => sessionRunStateDb.getById(id), listRunningRuns: () => chatRunRegistry.listRunningRuns(), isProcessing: (id) => chatRunRegistry.isProcessing(id), startRun: (input) => chatRunLifecycleService.start(input), now: () => Date.now(), intervalMs: 1_000, idleQuiescenceMs: 3_000 });
const appointmentsService = createAppointmentsService({ appointments: appointmentsDb, getProjectById: (id) => projectsDb.getProjectById(id), getSessionById: (id) => sessionsDb.getSessionById(id), dispatchNow: (row) => appointmentScheduler.dispatchNow(row), ...appointmentServiceDefaults });
export const appointmentsRouter = createAppointmentsRouter(appointmentsService);
