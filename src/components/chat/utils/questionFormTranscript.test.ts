import assert from 'node:assert/strict';
import test from 'node:test';

import type { QuestionForm } from '../types/types';

import { findSubsequentQuestionFormAnswers } from './questionFormTranscript';

const form: QuestionForm = {
  id: 'deployment-location',
  title: 'Choose a deployment location',
  questions: [
    {
      id: 'location',
      label: 'Choose one',
      type: 'radio',
      options: [
        { label: 'Locally on this computer', value: 'local' },
        { label: 'On a public URL', value: 'public' },
      ],
    },
  ],
};

test('finds the matching answer marker later in transcript order', () => {
  const transcript = [
    { type: 'user', content: 'Start here', timestamp: 1 },
    { type: 'assistant', content: '<question-form />', timestamp: 2 },
    {
      type: 'user',
      content: '[form answers — deployment-location]\n- Choose one: Locally on this computer [value: local]',
      timestamp: 3,
    },
  ];

  assert.deepEqual(findSubsequentQuestionFormAnswers(form, transcript, 1), { location: 'local' });
});

test('skips unrelated later user turns while searching for the matching marker', () => {
  const transcript = [
    { type: 'assistant', content: '<question-form />', timestamp: 1 },
    { type: 'user', content: 'I need to think about this.', timestamp: 2 },
    {
      type: 'user',
      content: '[form answers — deployment-location]\n- Choose one: On a public URL [value: public]',
      timestamp: 3,
    },
  ];

  assert.deepEqual(findSubsequentQuestionFormAnswers(form, transcript, 0), { location: 'public' });
});

test('does not pair an earlier repeated form id with the later occurrence answer', () => {
  const repeatedForm = `<question-form id="deployment-location">{"questions":[{"id":"location","label":"Choose one","type":"radio","options":[{"label":"Local","value":"local"}]}]}</question-form>`;
  const transcript = [
    { type: 'assistant', content: repeatedForm, timestamp: 1 },
    { type: 'assistant', content: repeatedForm, timestamp: 2 },
    {
      type: 'user',
      content: '[form answers — deployment-location]\n- Choose one: Local [value: local]',
      timestamp: 3,
    },
  ];

  assert.equal(findSubsequentQuestionFormAnswers(form, transcript, 0), null);
  assert.deepEqual(findSubsequentQuestionFormAnswers(form, transcript, 1), { location: 'local' });
});
