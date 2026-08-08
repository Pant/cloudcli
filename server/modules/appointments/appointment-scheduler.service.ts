import type { AppointmentRecord, SessionRunStateRecord } from '@/shared/types.js';
import { filterAttachmentsToUploadStore, isImageAttachmentDescriptor } from '@/shared/image-attachments.js';

type SchedulerDependencies = {
  appointments: {
    listDue(now?: number, limit?: number): AppointmentRecord[]; listProjectIdle(limit?: number): AppointmentRecord[]; listNextQueued(limit?: number): AppointmentRecord[]; listRunning(): AppointmentRecord[];
    markActiveProjectIdleNeedsReview(now?: number): number; claim(id: string, now?: number): AppointmentRecord | null;
    activateDraftForDispatch(id: string, projectId: string, userId: string | number, now?: number): AppointmentRecord | null;
    transition(id: string, expected: AppointmentRecord['status'], next: AppointmentRecord['status'], now?: number, error?: string | null): boolean;
    update(id: string, projectId: string, userId: string | number, input: { projectIdleSince?: number | null; now?: number }): AppointmentRecord | null;
    assignRunGeneration(id: string, generation: number, now?: number): boolean;
  };
  getSessionById(id: string): { project_path: string | null } | null;
  listRunningRuns(): Array<{ sessionId: string }>;
  getRunState(id: string): SessionRunStateRecord | null;
  isProcessing(id: string): boolean;
  startRun(input: { sessionId: string; command: string; options: Record<string, unknown>; connection: null; userId: string }): Promise<{ generation: number }>;
  now(): number; intervalMs: number; idleQuiescenceMs: number;
};

/** Polling scheduler used by the Appointments module and server lifecycle. */
export function createAppointmentScheduler(dependencies: SchedulerDependencies) {
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  async function dispatch(row: AppointmentRecord, now: number): Promise<'started' | 'session_busy' | 'claim_lost' | 'launch_failed'> {
    if (dependencies.isProcessing(row.sessionId)) return 'session_busy';
    const claimed = dependencies.appointments.claim(row.id, now);
    if (!claimed) return 'claim_lost';
    const attachments = filterAttachmentsToUploadStore(claimed.attachments);
    const options = { ...claimed.options, attachments, images: attachments.filter(isImageAttachmentDescriptor), files: attachments.filter((entry) => !isImageAttachmentDescriptor(entry)) };
    try {
      const started = await dependencies.startRun({ sessionId: claimed.sessionId, command: claimed.prompt, options, connection: null, userId: claimed.userId });
      dependencies.appointments.assignRunGeneration(claimed.id, started.generation, now);
      return 'started';
    } catch (error) {
      dependencies.appointments.transition(claimed.id, 'running', 'failed', now, error instanceof Error ? error.message : String(error));
      return 'launch_failed';
    }
  }
  function reconcile(now: number): void {
    for (const row of dependencies.appointments.listRunning()) {
      if (row.runGeneration === null) continue;
      const state = dependencies.getRunState(row.sessionId);
      if (!state || state.generation !== row.runGeneration) continue;
      if (state.lifecycleState === 'completed') dependencies.appointments.transition(row.id, 'running', 'completed', now);
      else if (['stalled', 'failed', 'exited', 'manually_stopped', 'recovery_exhausted'].includes(state.lifecycleState)) {
        dependencies.appointments.transition(row.id, 'running', 'failed', now, state.terminalMessage ?? state.terminalReason ?? state.lifecycleState);
      }
    }
  }
  function busyProjects(): Set<string> {
    const result = new Set<string>();
    for (const run of dependencies.listRunningRuns()) {
      const projectPath = dependencies.getSessionById(run.sessionId)?.project_path;
      if (projectPath) result.add(projectPath);
    }
    for (const appointment of dependencies.appointments.listRunning()) {
      const projectPath = dependencies.getSessionById(appointment.sessionId)?.project_path;
      if (projectPath) result.add(projectPath);
    }
    return result;
  }
  async function dispatchNow(row: AppointmentRecord): Promise<'started' | 'project_busy' | 'session_busy' | 'stale' | 'launch_failed'> {
    const projectPath = dependencies.getSessionById(row.sessionId)?.project_path;
    if (!projectPath || busyProjects().has(projectPath)) return 'project_busy';
    if (dependencies.isProcessing(row.sessionId)) return 'session_busy';
    const now = dependencies.now();
    let dispatchable = row;
    if (row.status === 'draft') {
      const activated = dependencies.appointments.activateDraftForDispatch(row.id, row.projectId, row.userId, now);
      if (!activated) return 'stale';
      dispatchable = activated;
    }
    const result = await dispatch(dispatchable, now);
    return result === 'claim_lost' ? 'stale' : result;
  }
  async function tick(): Promise<void> {
    if (ticking) return; ticking = true;
    try {
      const now = dependencies.now();
      reconcile(now);
      for (const row of dependencies.appointments.listDue(now)) await dispatch(row, now);
      const runningProjects = busyProjects();
      for (const row of dependencies.appointments.listProjectIdle()) {
        if (dependencies.isProcessing(row.sessionId)) { if (row.projectIdleSince !== null) dependencies.appointments.update(row.id, row.projectId, row.userId, { projectIdleSince: null, now }); continue; }
        const projectPath = dependencies.getSessionById(row.sessionId)?.project_path;
        if (!projectPath || runningProjects.has(projectPath)) { if (row.projectIdleSince !== null) dependencies.appointments.update(row.id, row.projectId, row.userId, { projectIdleSince: null, now }); continue; }
        if (row.projectIdleSince === null) { dependencies.appointments.update(row.id, row.projectId, row.userId, { projectIdleSince: now, now }); continue; }
        if (now - row.projectIdleSince >= dependencies.idleQuiescenceMs) await dispatch(row, now);
      }
      const dispatchedProjects = new Set<string>();
      for (const row of dependencies.appointments.listNextQueued()) {
        const projectPath = dependencies.getSessionById(row.sessionId)?.project_path;
        if (!projectPath || runningProjects.has(projectPath) || dispatchedProjects.has(projectPath) || dependencies.isProcessing(row.sessionId)) continue;
        await dispatch(row, now);
        dispatchedProjects.add(projectPath);
      }
    } finally { ticking = false; }
  }
  return {
    start() { if (timer) return; dependencies.appointments.markActiveProjectIdleNeedsReview(dependencies.now()); timer = setInterval(() => void tick(), dependencies.intervalMs); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    dispatchNow,
  };
}
