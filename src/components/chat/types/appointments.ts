export type AppointmentTrigger = 'exact' | 'timer' | 'project_idle' | 'queue';

export type AppointmentStatus =
  | 'draft'
  | 'scheduled'
  | 'needs_review'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type PromptAppointment = {
  id: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  triggerType: AppointmentTrigger;
  dueAt: number | null;
  timerDurationMs: number | null;
  isActive: boolean;
  status: AppointmentStatus;
  errorMessage: string | null;
  queuePosition: number | null;
  runGeneration: number | null;
  createdAt: number;
  updatedAt: number;
};

export type AppointmentCreationForm = {
  triggerType: AppointmentTrigger;
  localDateTime: string;
  timerAmount: string;
  timerUnit: 'minutes' | 'hours' | 'days';
  isActive: boolean;
};

export type AppointmentTriggerRequest = {
  triggerType: AppointmentTrigger;
  dueAt: number | null;
  timerDurationMs: number | null;
  isActive: boolean;
};

export type AppointmentCreateRequest = AppointmentTriggerRequest & {
  sessionId: string;
  prompt: string;
  options: Record<string, unknown>;
  attachments: unknown[];
};

export type AppointmentApiResponse<T> = {
  success: boolean;
  data: T;
};
