import type {
  AppointmentCreationForm,
  AppointmentStatus,
  AppointmentTriggerRequest,
  PromptAppointment,
} from '../../types/appointments';

const DURATION_MULTIPLIERS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

export function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function durationToMilliseconds(amount: string, unit: AppointmentCreationForm['timerUnit']): number | null {
  const value = Number(amount);
  return Number.isFinite(value) && value > 0 ? value * DURATION_MULTIPLIERS[unit] : null;
}

export function validateAppointmentForm(form: AppointmentCreationForm, now = Date.now()): string | null {
  if (form.triggerType === 'exact') {
    const iso = localDateTimeToIso(form.localDateTime);
    if (!iso) return 'Choose a valid date and time.';
    if (new Date(iso).getTime() <= now) return 'Choose a date and time in the future.';
  }
  if (form.triggerType === 'timer' && durationToMilliseconds(form.timerAmount, form.timerUnit) === null) {
    return 'Enter a timer duration greater than zero.';
  }
  return null;
}

export function buildAppointmentTriggerRequest(
  form: AppointmentCreationForm,
  now = Date.now(),
): AppointmentTriggerRequest {
  const error = validateAppointmentForm(form, now);
  if (error) throw new Error(error);
  const timerDurationMs = form.triggerType === 'timer'
    ? durationToMilliseconds(form.timerAmount, form.timerUnit)
    : null;
  const dueAt = form.triggerType === 'exact'
    ? new Date(localDateTimeToIso(form.localDateTime) as string).getTime()
    : form.triggerType === 'timer' && timerDurationMs
      ? now + timerDurationMs
      : null;
  return { triggerType: form.triggerType, dueAt, timerDurationMs, isActive: form.isActive };
}

export function appointmentStatusLabel(status: AppointmentStatus): string {
  return status.replace('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatLocalDateTime(timestamp: number | null): string {
  return timestamp === null ? 'When project tasks finish' : new Date(timestamp).toLocaleString();
}

export function extractMutableQueue(appointments: PromptAppointment[]): PromptAppointment[] {
  return appointments
    .filter((appointment) => appointment.triggerType === 'queue'
      && (appointment.status === 'draft' || appointment.status === 'scheduled'))
    .sort((left, right) => (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id));
}

export function reorderQueueIds(appointments: PromptAppointment[], appointmentId: string, direction: -1 | 1): string[] | null {
  const ids = extractMutableQueue(appointments).map((appointment) => appointment.id);
  const index = ids.indexOf(appointmentId);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= ids.length) return null;
  [ids[index], ids[destination]] = [ids[destination], ids[index]];
  return ids;
}
