import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { PromptAppointment } from '../types/appointments';

import { shouldAutoOpenAppointmentReview } from './appointmentReview';

const row = (status: PromptAppointment['status']) => ({ status } as PromptAppointment);

test('needs_review auto-opens once per project while ordinary rows do not', () => {
  assert.equal(shouldAutoOpenAppointmentReview([row('scheduled')], 'p1', new Set()), false);
  assert.equal(shouldAutoOpenAppointmentReview([row('needs_review')], 'p1', new Set()), true);
  assert.equal(shouldAutoOpenAppointmentReview([row('needs_review')], 'p1', new Set(['p1'])), false);
});

test('appointment modal remains a lazy boundary and only renders while open', async () => {
  const source = await readFile(new URL('./ChatInterface.tsx', import.meta.url), 'utf8');
  assert.match(source, /React\.lazy\(\(\) => import\('\.\/subcomponents\/PromptAppointmentModal'\)\)/);
  assert.match(source, /\{appointmentModalOpen && \(/);
  assert.doesNotMatch(source, /import PromptAppointmentModal from/);
});
