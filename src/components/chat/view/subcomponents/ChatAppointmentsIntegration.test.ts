import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const composerSource = readFileSync(new URL('./ChatComposer.tsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('../../hooks/useChatComposerState.ts', import.meta.url), 'utf8');
const modalSource = readFileSync(new URL('./PromptAppointmentModal.tsx', import.meta.url), 'utf8');

test('appointment control is rendered immediately before Send', () => {
  const clock = composerSource.indexOf('tooltip={{ content: t(\'appointments.open\') }}');
  const send = composerSource.indexOf('<PromptInputSubmit', clock);
  assert.ok(clock >= 0);
  assert.ok(send > clock);
  assert.doesNotMatch(composerSource.slice(clock, send), /disabled=/);
});

test('appointment API errors prefer the standard nested message', () => {
  assert.match(stateSource, /body\?\.error\?\.message/);
  assert.match(modalSource, /body\?\.error\?\.message/);
  assert.match(stateSource, /typeof body\?\.error === 'string'/);
  assert.match(modalSource, /typeof body\?\.error === 'string'/);
});

test('scheduling snapshots options and attachments and clears only after persistence', () => {
  const schedule = stateSource.slice(stateSource.indexOf('const scheduleAppointment'));
  const create = schedule.indexOf('api.createProjectAppointment');
  const clear = schedule.indexOf('clearComposerAfterSuccess();');
  assert.match(schedule, /prompt,/);
  assert.match(schedule, /options: buildSendOptions\(prompt\)/);
  assert.match(schedule, /attachments,/);
  assert.match(schedule, /allocateStableSession\(prompt\)/);
  assert.ok(create >= 0 && clear > create);
  assert.doesNotMatch(schedule.slice(0, create), /submitChatMessage/);
});
