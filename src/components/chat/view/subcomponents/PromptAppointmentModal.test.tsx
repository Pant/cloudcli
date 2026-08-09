import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import type { PromptAppointment } from '../../types/appointments';

import { PromptAppointmentModalContent } from './PromptAppointmentModal';
import {
  appointmentStatusLabel,
  buildAppointmentTriggerRequest,
  durationToMilliseconds,
  extractMutableQueue,
  localDateTimeToIso,
  validateAppointmentForm,
  reorderQueueIds,
} from './PromptAppointmentModal.utils';

const testI18n = createInstance();
await testI18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: {} } },
  interpolation: { escapeValue: false },
});

const renderModal = (component: React.ReactElement) => renderToStaticMarkup(
  <I18nextProvider i18n={testI18n}>{component}</I18nextProvider>,
);

test('validates local dates and durable timer payloads', () => {
  assert.equal(localDateTimeToIso('not-a-date'), null);
  assert.equal(durationToMilliseconds('2', 'hours'), 7_200_000);
  assert.match(validateAppointmentForm({ triggerType: 'exact', localDateTime: '2020-01-01T00:00', timerAmount: '1', timerUnit: 'minutes', isActive: true }, Date.parse('2026-01-01')) || '', /future/);
  assert.match(validateAppointmentForm({ triggerType: 'timer', localDateTime: '', timerAmount: '0', timerUnit: 'minutes', isActive: true }) || '', /greater than zero/);
  assert.deepEqual(buildAppointmentTriggerRequest({ triggerType: 'timer', localDateTime: '', timerAmount: '30', timerUnit: 'minutes', isActive: false }, 1_000), { triggerType: 'timer', dueAt: 1_801_000, timerDurationMs: 1_800_000, isActive: false });
  assert.equal(appointmentStatusLabel('needs_review'), 'Needs Review');
  assert.deepEqual(buildAppointmentTriggerRequest({ triggerType: 'queue', localDateTime: '', timerAmount: '1', timerUnit: 'minutes', isActive: true }), { triggerType: 'queue', dueAt: null, timerDurationMs: null, isActive: true });
});

const queueAppointment = (id: string, queuePosition: number, status: PromptAppointment['status'] = 'scheduled'): PromptAppointment => ({
  id, projectId: 'project-1', sessionId: `session-${id}`, prompt: `Prompt ${id}`, triggerType: 'queue',
  dueAt: null, timerDurationMs: null, isActive: status === 'scheduled', status, errorMessage: null,
  queuePosition, runGeneration: null, createdAt: queuePosition, updatedAt: queuePosition,
});

test('extracts durable mutable pipeline order and reorders complete ID sets', () => {
  const rows = [queueAppointment('second', 20), queueAppointment('terminal', 5, 'completed'), queueAppointment('first', 10)];
  assert.deepEqual(extractMutableQueue(rows).map(({ id }) => id), ['first', 'second']);
  assert.deepEqual(reorderQueueIds(rows, 'second', -1), ['second', 'first']);
  assert.equal(reorderQueueIds(rows, 'first', -1), null);
  assert.equal(reorderQueueIds(rows, 'second', 1), null);
});

test('renders accessible trigger, draft, management, and restart review states', () => {
  const appointment: PromptAppointment = {
    id: 'appointment-1', projectId: 'project-1', sessionId: 'session-1', prompt: 'Run checks',
    triggerType: 'project_idle', dueAt: null, timerDurationMs: null, isActive: true,
    status: 'needs_review', errorMessage: null, queuePosition: null, runGeneration: null, createdAt: 1, updatedAt: 1,
  };
  const html = renderModal(<PromptAppointmentModalContent projectId="project-1" prompt="Ship this" appointments={[appointment]} onCreate={() => undefined} />);
  assert.match(html, /appointments\.trigger\.exact\.title/);
  assert.match(html, /appointments\.trigger\.timer\.title/);
  assert.match(html, /appointments\.trigger\.project_idle\.title/);
  assert.match(html, /appointments\.trigger\.queue\.title/);
  assert.match(html, /role="switch"/);
  assert.match(html, /appointments\.review\.title/);
  assert.match(html, /appointments\.actions\.postpone/);
  assert.match(html, /appointments\.actions\.makeDraft/);
  assert.match(html, /appointments\.actions\.cancel/);
});

test('renders an ordered pipeline with position semantics and disabled boundary controls', () => {
  const html = renderModal(<PromptAppointmentModalContent projectId="project-1" prompt="Ship this" appointments={[queueAppointment('second', 2, 'draft'), queueAppointment('first', 1)]} onCreate={() => undefined} />);
  assert.match(html, /<ol/);
  assert.ok(html.indexOf('Prompt first') < html.indexOf('Prompt second'));
  assert.match(html, /appointments\.pipeline\.position/);
  assert.match(html, /appointments\.pipeline\.moveUp[^>]*" disabled=""/);
  assert.match(html, /appointments\.pipeline\.moveDown[^>]*" disabled=""/);
  assert.equal(html.match(/appointments\.actions\.dispatchNow/g)?.length, 2);
  assert.match(html, /appointments\.actions\.makeDraft/);
  assert.match(html, /appointments\.actions\.activate/);
  assert.doesNotMatch(html, /appointments\.actions\.dispatching/);
});
