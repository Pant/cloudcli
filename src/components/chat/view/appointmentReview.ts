import type { PromptAppointment } from '../types/appointments';

export const shouldAutoOpenAppointmentReview = (
  rows: PromptAppointment[],
  projectId: string,
  openedProjects: ReadonlySet<string>,
) => !openedProjects.has(projectId) && rows.some((row) => row.status === 'needs_review');
