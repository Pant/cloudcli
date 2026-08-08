import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { QuestionForm } from '../../types/types';

import { QuestionFormCard, QuestionFormSummary } from './QuestionFormCard';
import {
  buildInitialQuestionFormAnswers,
  createQuestionFormSubmission,
  formatQuestionFormAnswerForSummary,
  isQuestionFormSubmissionAccepted,
  isQuestionFormValid,
} from './QuestionFormCard.utils';

const form: QuestionForm = {
  id: 'deployment-location',
  title: 'Choose a deployment location',
  description: 'Tell us where the project should run.',
  submitLabel: 'Continue',
  questions: [
    {
      id: 'location',
      label: 'Choose one',
      type: 'radio',
      required: true,
      defaultValue: 'local',
      help: 'You can change this later.',
      options: [
        { label: 'Locally on this computer', value: 'local' },
        { label: 'On a public URL', value: 'public' },
      ],
    },
    {
      id: 'notes',
      label: 'Notes',
      type: 'textarea',
      placeholder: 'Anything else to consider?',
      description: 'Optional context for the next step.',
    },
  ],
};

test('seeds defaults, normalizes option labels, and validates required answers', () => {
  const answers = buildInitialQuestionFormAnswers(form, { notes: 'Prefer a small release.' });

  assert.deepEqual(answers, {
    location: 'local',
    notes: 'Prefer a small release.',
  });
  assert.equal(isQuestionFormValid(form, answers), true);
  assert.equal(isQuestionFormValid(form, { location: '', notes: '' }), false);
  assert.equal(formatQuestionFormAnswerForSummary(form.questions[0]!, 'local'), 'Locally on this computer');
});

test('creates a TODO 5-ready submission with the normal chat message body', () => {
  const submission = createQuestionFormSubmission(form, { location: 'public', notes: 'Review access.' });

  assert.equal(submission.formId, 'deployment-location');
  assert.deepEqual(submission.answers, { location: 'public', notes: 'Review access.' });
  assert.equal(
    submission.message,
    '[form answers — deployment-location]\n- Choose one: On a public URL [value: public]\n- Notes: Review access.',
  );
});

test('locks only accepted submissions and rejects an explicit false result', () => {
  assert.equal(isQuestionFormSubmissionAccepted(undefined), true);
  assert.equal(isQuestionFormSubmissionAccepted(true), true);
  assert.equal(isQuestionFormSubmissionAccepted(false), false);
});

test('renders native accessible controls, labels, help text, defaults, and disabled validation state', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionFormCard, { form, onSubmit: () => undefined }),
  );

  assert.match(html, /data-question-form-card/);
  assert.match(html, /Choose a deployment location/);
  assert.match(html, /Tell us where the project should run\./);
  assert.match(html, /type="radio"/);
  assert.match(html, /<textarea/);
  assert.match(html, /Locally on this computer/);
  assert.match(html, /You can change this later\./);
  assert.match(html, /Optional context for the next step\./);
  assert.match(html, /checked=""/);
  assert.match(html, /aria-label="Required"/);
  assert.match(html, /placeholder="Anything else to consider\?"/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Continue/);
});

test('disables submit until a required question has an answer', () => {
  const requiredForm: QuestionForm = {
    ...form,
    questions: [{ ...form.questions[0]!, defaultValue: undefined }],
  };
  const html = renderToStaticMarkup(
    React.createElement(QuestionFormCard, { form: requiredForm, onSubmit: () => undefined }),
  );

  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.match(html, /required=""/);
});

test('renders an unsupported runtime type as a safe text fallback', () => {
  const unsupportedForm = {
    ...form,
    questions: [{ ...form.questions[1]!, type: 'calendar' as never }],
  };
  const html = renderToStaticMarkup(
    React.createElement(QuestionFormCard, { form: unsupportedForm, onSubmit: () => undefined }),
  );

  assert.match(html, /type="text"/);
  assert.doesNotMatch(html, /calendar/);
  assert.doesNotMatch(html, /question-form JSON/);
});

test('renders every supported native control family', () => {
  const controlsForm: QuestionForm = {
    id: 'controls',
    title: 'Controls',
    questions: [
      { id: 'checks', label: 'Checks', type: 'checkbox', options: [{ label: 'One', value: 'one' }] },
      { id: 'choice', label: 'Choice', type: 'select', options: [{ label: 'A', value: 'a' }] },
      { id: 'name', label: 'Name', type: 'text', placeholder: 'Type a name' },
    ],
  };
  const html = renderToStaticMarkup(
    React.createElement(QuestionFormCard, { form: controlsForm, onSubmit: () => undefined }),
  );

  assert.match(html, /type="checkbox"/);
  assert.match(html, /<select/);
  assert.match(html, /type="text"/);
  assert.match(html, /placeholder="Type a name"/);
});

test('renders a compact answered summary with question labels and option labels', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionFormSummary, {
      form,
      answers: { location: 'public', notes: 'Use the shared preview.' },
    }),
  );

  assert.match(html, /data-question-form-summary/);
  assert.match(html, /Answered/);
  assert.match(html, /Choose one/);
  assert.match(html, /On a public URL/);
  assert.match(html, /Use the shared preview\./);
  assert.doesNotMatch(html, /type="submit"/);
});
