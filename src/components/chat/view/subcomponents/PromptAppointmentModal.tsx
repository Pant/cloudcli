import React, { useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, Check, Clock3, ListOrdered, ListTodo, Timer, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SettingsToggle from '../../../settings/view/SettingsToggle';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../shared/view/ui';
import { api } from '../../../../utils/api';
import type {
  AppointmentCreationForm,
  AppointmentTrigger,
  PromptAppointment,
} from '../../types/appointments';

import {
  appointmentStatusLabel,
  buildAppointmentTriggerRequest,
  formatLocalDateTime,
  extractMutableQueue,
  localDateTimeToIso,
  validateAppointmentForm,
  reorderQueueIds,
} from './PromptAppointmentModal.utils';

type PromptAppointmentModalProps = {
  open: boolean;
  onClose: () => void;
  projectId: string;
  prompt: string;
  attachmentCount?: number;
  appointments?: PromptAppointment[];
  loading?: boolean;
  submitting?: boolean;
  error?: string | null;
  onCreate: (request: ReturnType<typeof buildAppointmentTriggerRequest>) => Promise<void> | void;
  onAppointmentsChange?: () => Promise<void> | void;
};

const INITIAL_FORM: AppointmentCreationForm = {
  triggerType: 'exact', localDateTime: '', timerAmount: '30', timerUnit: 'minutes', isActive: true,
};

const TRIGGERS: Array<{ type: AppointmentTrigger; icon: typeof Clock3 }> = [
  { type: 'exact', icon: CalendarClock }, { type: 'timer', icon: Timer }, { type: 'project_idle', icon: ListTodo }, { type: 'queue', icon: ListOrdered },
];

export function PromptAppointmentModalContent({
  projectId,
  prompt,
  attachmentCount = 0,
  appointments = [],
  loading = false,
  submitting = false,
  error,
  onCreate,
  onAppointmentsChange,
}: Omit<PromptAppointmentModalProps, 'open' | 'onClose'>) {
  const { t } = useTranslation('chat');
  const [form, setForm] = useState<AppointmentCreationForm>(INITIAL_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [postponeValues, setPostponeValues] = useState<Record<string, string>>({});
  const [reordering, setReordering] = useState(false);
  const [dispatchingAppointmentId, setDispatchingAppointmentId] = useState<string | null>(null);
  const canCreate = Boolean(prompt.trim() || attachmentCount);
  const pipeline = extractMutableQueue(appointments);
  const history = appointments.filter((appointment) => !pipeline.some((entry) => entry.id === appointment.id));

  const manage = async (request: Promise<Response>) => {
    if (dispatchingAppointmentId) return;
    try {
      const response = await request;
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.error?.message
          || (typeof body?.error === 'string' ? body.error : null)
          || body?.message
          || t('appointments.validation.managementFailed'),
        );
      }
      setFormError(null);
      onAppointmentsChange?.();
    } catch (managementError) {
      setFormError(managementError instanceof Error ? managementError.message : t('appointments.validation.managementFailed'));
    }
  };

  const moveQueueEntry = async (appointmentId: string, direction: -1 | 1) => {
    if (reordering || dispatchingAppointmentId) return;
    const appointmentIds = reorderQueueIds(appointments, appointmentId, direction);
    if (!appointmentIds) return;
    setReordering(true);
    setFormError(null);
    try {
      const response = await api.reorderProjectAppointments(projectId, appointmentIds);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message || (typeof body?.error === 'string' ? body.error : null)
          || body?.message || t('appointments.pipeline.reorderFailed'));
      }
      await onAppointmentsChange?.();
    } catch (reorderError) {
      setFormError(reorderError instanceof Error ? reorderError.message : t('appointments.pipeline.reorderFailed'));
    } finally {
      setReordering(false);
    }
  };

  const dispatchNow = async (appointmentId: string) => {
    if (dispatchingAppointmentId) return;
    setDispatchingAppointmentId(appointmentId);
    setFormError(null);
    try {
      const response = await api.dispatchProjectAppointment(projectId, appointmentId);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.error?.message
          || (typeof body?.error === 'string' ? body.error : null)
          || body?.message
          || t('appointments.pipeline.dispatchFailed'),
        );
      }
      await onAppointmentsChange?.();
    } catch (dispatchError) {
      setFormError(dispatchError instanceof Error ? dispatchError.message : t('appointments.pipeline.dispatchFailed'));
    } finally {
      setDispatchingAppointmentId(null);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validation = validateAppointmentForm(form);
    if (validation) return setFormError(validation);
    if (!canCreate) return setFormError(t('appointments.validation.promptRequired'));
    setFormError(null);
    try {
      await onCreate(buildAppointmentTriggerRequest(form));
      onAppointmentsChange?.();
    } catch (creationError) {
      setFormError(creationError instanceof Error ? creationError.message : t('appointments.validation.managementFailed'));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6">
      <form className="space-y-5" onSubmit={submit}>
        <section aria-labelledby="appointment-prompt-heading" className="rounded-2xl border border-border/70 bg-muted/20 p-4">
          <h3 id="appointment-prompt-heading" className="text-sm font-semibold">{t('appointments.currentPrompt')}</h3>
          <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
            {prompt.trim() || t('appointments.noPrompt')}
          </p>
          {attachmentCount > 0 && <p className="mt-2 text-xs text-muted-foreground">{t('appointments.attachments', { count: attachmentCount })}</p>}
        </section>

        <fieldset>
          <legend className="mb-3 text-sm font-semibold">{t('appointments.trigger.heading')}</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {TRIGGERS.map(({ type, icon: Icon }) => {
              const selected = form.triggerType === type;
              return <button key={type} type="button" aria-pressed={selected} onClick={() => setForm({ ...form, triggerType: type })}
                className={`rounded-2xl border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-primary bg-primary/10' : 'border-border/70 bg-background'}`}>
                <span className="flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4" />{t(`appointments.trigger.${type}.title`)}</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">{t(`appointments.trigger.${type}.description`)}</span>
              </button>;
            })}
          </div>
        </fieldset>

        {form.triggerType === 'exact' && <label className="block text-sm font-medium">{t('appointments.exactLabel')}
          <Input type="datetime-local" value={form.localDateTime} onChange={(event) => setForm({ ...form, localDateTime: event.target.value })} className="mt-2" />
        </label>}
        {form.triggerType === 'timer' && <div className="grid grid-cols-[1fr_auto] gap-2">
          <label className="text-sm font-medium">{t('appointments.timerAmount')}<Input type="number" min="0.01" step="any" value={form.timerAmount} onChange={(event) => setForm({ ...form, timerAmount: event.target.value })} className="mt-2" /></label>
          <label className="text-sm font-medium">{t('appointments.timerUnit')}<select value={form.timerUnit} onChange={(event) => setForm({ ...form, timerUnit: event.target.value as AppointmentCreationForm['timerUnit'] })} className="mt-2 h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="minutes">{t('appointments.units.minutes')}</option><option value="hours">{t('appointments.units.hours')}</option><option value="days">{t('appointments.units.days')}</option></select></label>
        </div>}

        <div className="flex items-center justify-between rounded-2xl border border-border/70 p-4">
          <div><p className="text-sm font-semibold">{form.isActive ? t('appointments.active') : t('appointments.draft')}</p><p className="text-xs text-muted-foreground">{t('appointments.activeHelp')}</p></div>
          <SettingsToggle checked={form.isActive} onChange={(isActive) => setForm({ ...form, isActive })} ariaLabel={t('appointments.activeSwitch')} />
        </div>
        {(formError || error) && <p role="alert" className="text-sm text-destructive">{formError || error}</p>}
        <Button type="submit" disabled={!canCreate || submitting}>{submitting ? t('appointments.scheduling') : t('appointments.schedule')}</Button>
      </form>

      {pipeline.length > 0 && <section aria-labelledby="appointment-pipeline-heading" className="mt-7 border-t border-border/70 pt-5">
        <h3 id="appointment-pipeline-heading" className="text-base font-semibold">{t('appointments.pipeline.heading')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('appointments.pipeline.help')}</p>
        <ol className="mt-3 space-y-3">
          {pipeline.map((appointment, index) => <li key={appointment.id} className="rounded-2xl border border-border/70 bg-background/75 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="text-xs font-semibold text-muted-foreground">{t('appointments.pipeline.position', { position: index + 1, total: pipeline.length })}</p><p className="mt-1 line-clamp-2 text-sm font-medium">{appointment.prompt || t('appointments.attachmentPrompt')}</p></div>
              <div className="flex shrink-0 gap-1">
                 <Button type="button" size="icon" variant="outline" aria-label={t('appointments.pipeline.moveUp', { position: index + 1 })} disabled={reordering || Boolean(dispatchingAppointmentId) || index === 0} onClick={() => void moveQueueEntry(appointment.id, -1)}><ArrowUp className="h-4 w-4" /></Button>
                 <Button type="button" size="icon" variant="outline" aria-label={t('appointments.pipeline.moveDown', { position: index + 1 })} disabled={reordering || Boolean(dispatchingAppointmentId) || index === pipeline.length - 1} onClick={() => void moveQueueEntry(appointment.id, 1)}><ArrowDown className="h-4 w-4" /></Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" onClick={() => void dispatchNow(appointment.id)} disabled={Boolean(dispatchingAppointmentId)}>{dispatchingAppointmentId === appointment.id ? t('appointments.actions.dispatching') : t('appointments.actions.dispatchNow')}</Button><Button type="button" size="sm" variant="outline" disabled={Boolean(dispatchingAppointmentId)} onClick={() => void manage(api.setAppointmentActive(projectId, appointment.id, !appointment.isActive))}>{appointment.isActive ? t('appointments.actions.makeDraft') : t('appointments.actions.activate')}</Button><Button type="button" size="sm" variant="destructive" disabled={Boolean(dispatchingAppointmentId)} onClick={() => void manage(api.cancelAppointment(projectId, appointment.id))}>{t('appointments.actions.cancel')}</Button></div>
          </li>)}
        </ol>
        {reordering && <p role="status" className="mt-2 text-sm text-muted-foreground">{t('appointments.pipeline.saving')}</p>}
      </section>}

      <section aria-labelledby="project-appointments-heading" className="mt-7 border-t border-border/70 pt-5">
        <h3 id="project-appointments-heading" className="text-base font-semibold">{t('appointments.listHeading')}</h3>
        {loading && <p className="mt-3 text-sm text-muted-foreground">{t('appointments.loading')}</p>}
        {!loading && appointments.length === 0 && <p className="mt-3 rounded-2xl border border-dashed p-5 text-center text-sm text-muted-foreground">{t('appointments.empty')}</p>}
        <div className="mt-3 space-y-3">
          {history.map((appointment) => <article key={appointment.id} className="rounded-2xl border border-border/70 bg-background/75 p-4">
            {appointment.status === 'needs_review' && <div role="alert" className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-300"><AlertTriangle className="h-4 w-4" />{t('appointments.review.title')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('appointments.review.description')}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row"><Input aria-label={t('appointments.review.postponeDate')} type="datetime-local" value={postponeValues[appointment.id] || ''} onChange={(event) => setPostponeValues({ ...postponeValues, [appointment.id]: event.target.value })} /><Button type="button" size="sm" onClick={() => { const dueAt = localDateTimeToIso(postponeValues[appointment.id] || ''); const dueAtMs = dueAt ? new Date(dueAt).getTime() : null; if (dueAtMs && dueAtMs > Date.now()) void manage(api.postponeAppointment(projectId, appointment.id, dueAtMs)); }}>{t('appointments.actions.postpone')}</Button><Button type="button" size="sm" variant="outline" onClick={() => void manage(api.setAppointmentActive(projectId, appointment.id, false))}>{t('appointments.actions.makeDraft')}</Button></div>
            </div>}
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="line-clamp-2 text-sm font-medium">{appointment.prompt || t('appointments.attachmentPrompt')}</p><p className="mt-1 text-xs text-muted-foreground">{formatLocalDateTime(appointment.dueAt)} · {appointmentStatusLabel(appointment.status)}</p></div><span className="rounded-full border px-2 py-1 text-[11px] font-semibold">{appointmentStatusLabel(appointment.status)}</span></div>
            <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={() => void manage(api.setAppointmentActive(projectId, appointment.id, !appointment.isActive))}>{appointment.isActive ? t('appointments.actions.makeDraft') : t('appointments.actions.activate')}</Button><Button type="button" size="sm" variant="destructive" onClick={() => void manage(api.cancelAppointment(projectId, appointment.id))}>{t('appointments.actions.cancel')}</Button></div>
          </article>)}
        </div>
      </section>
    </div>
  );
}

export default function PromptAppointmentModal({ open, onClose, ...props }: PromptAppointmentModalProps) {
  const { t } = useTranslation('chat');
  return <Dialog open={open} onOpenChange={(next) => !next && onClose()}><DialogContent className="flex h-[min(92dvh,52rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col overflow-hidden rounded-3xl p-0"><DialogTitle>{t('appointments.title')}</DialogTitle><header className="flex shrink-0 items-start justify-between border-b px-4 py-4 sm:px-6"><div className="flex gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl border bg-muted"><Clock3 className="h-5 w-5" /></span><div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('appointments.eyebrow')}</p><h2 className="text-xl font-semibold">{t('appointments.title')}</h2><p className="text-sm text-muted-foreground">{t('appointments.subtitle')}</p></div></div><Button type="button" variant="ghost" size="icon" aria-label={t('appointments.close')} onClick={onClose}><X /></Button></header><PromptAppointmentModalContent {...props} /><footer className="flex shrink-0 items-center gap-2 border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground"><Check className="h-4 w-4" />{t('appointments.footer')}</footer></DialogContent></Dialog>;
}
