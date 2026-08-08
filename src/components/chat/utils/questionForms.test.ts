import assert from 'node:assert/strict';
import test from 'node:test';

import type { QuestionForm } from '../types/types';

import {
  formatFormAnswers,
  hasUnterminatedQuestionForm,
  parseFormAnswerMarker,
  parseFormAnswers,
  parseQuestionFormAnswerMarker,
  splitOnQuestionForms,
  stripTrailingOpenQuestionForm,
} from './questionForms';

const deploymentLocationFormText = `<question-form id="deployment-location" title="Choose a deployment location">
{
  "questions": [
    {
      "id": "location",
      "label": "Choose one",
      "type": "radio",
      "required": true,
      "default": "local",
      "options": [
        { "label": "Locally on this computer", "value": "local" },
        { "label": "On a public URL", "value": "public" }
      ]
    }
  ]
}
</question-form>`;

test('parses the exact deployment-location form and preserves the machine value', () => {
  const segments = splitOnQuestionForms(deploymentLocationFormText);

  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, 'form');
  if (segments[0]?.kind !== 'form') return;

  assert.deepEqual(segments[0].form, {
    id: 'deployment-location',
    title: 'Choose a deployment location',
    questions: [
      {
        id: 'location',
        label: 'Choose one',
        type: 'radio',
        required: true,
        defaultValue: 'local',
        options: [
          { label: 'Locally on this computer', value: 'local' },
          { label: 'On a public URL', value: 'public' },
        ],
      },
    ],
  });
});

test('keeps prose before and after a form in ordered segments', () => {
  const segments = splitOnQuestionForms(
    `Before the questions.\n\n${deploymentLocationFormText}\n\nAfter the questions.`,
  );

  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ['text', 'form', 'text'],
  );
  assert.equal(
    segments[0]?.kind === 'text' ? segments[0].text : '',
    'Before the questions.\n\n',
  );
  assert.equal(segments[2]?.kind === 'text' ? segments[2].text : '', '\n\nAfter the questions.');
});

test('normalizes string and object options plus default/defaultValue aliases', () => {
  const segments = splitOnQuestionForms(`<question-form id="defaults">
  {
    "questions": [
      {
        "id": "location",
        "label": "Location",
        "type": "select",
        "default": "Local",
        "options": ["Local", {"label":"Public", "value":"cloud", "description":"Shareable URL"}]
      },
      {
        "id": "features",
        "label": "Features",
        "type": "checkbox",
        "defaultValue": ["One", "two"],
        "options": [{"label":"One", "value":"feature-one"}, {"label":"Two", "value":"two"}]
      }
    ]
  }
</question-form>`);

  assert.equal(segments[0]?.kind, 'form');
  if (segments[0]?.kind !== 'form') return;

  assert.deepEqual(segments[0].form.questions[0], {
    id: 'location',
    label: 'Location',
    type: 'select',
    defaultValue: 'Local',
    options: [
      { label: 'Local', value: 'Local' },
      { label: 'Public', value: 'cloud', description: 'Shareable URL' },
    ],
  });
  assert.deepEqual(segments[0].form.questions[1]?.defaultValue, ['feature-one', 'two']);
});

test('accepts fenced JSON and case-insensitive question-form tags', () => {
  const segments = splitOnQuestionForms(`<QUESTION-FORM ID='fenced' TITLE='Fenced'>
\n\`\`\`json
{"questions":[{"id":"name","label":"Name","type":"text"}]}
\`\`\`
</QUESTION-FORM>`);

  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, 'form');
  if (segments[0]?.kind !== 'form') return;
  assert.equal(segments[0].form.id, 'fenced');
  assert.equal(segments[0].form.title, 'Fenced');
});

test('replaces malformed completed forms with a safe fallback and no raw JSON', () => {
  const secret = 'do-not-leak-this-json';
  const segments = splitOnQuestionForms(
    `Intro\n<question-form id="broken">{"questions":[{"label":"${secret}"}]oops}</question-form>\nOutro`,
  );

  assert.deepEqual(segments.map((segment) => segment.kind), ['text', 'fallback', 'text']);
  assert.equal(segments[1]?.kind === 'fallback' ? segments[1].text.includes(secret) : true, false);
  assert.equal(JSON.stringify(segments).includes(secret), false);
});

test('suppresses an incomplete trailing streaming form while preserving preceding prose', () => {
  const streaming = 'The answer is almost ready.\n<question-form id="streaming">{"questions":[';
  const segments = splitOnQuestionForms(streaming);
  const stripped = stripTrailingOpenQuestionForm(streaming);

  assert.deepEqual(segments, [{ kind: 'text', text: 'The answer is almost ready.\n' }]);
  assert.deepEqual(stripped, { text: 'The answer is almost ready.\n', hadOpenForm: true });
  assert.equal(hasUnterminatedQuestionForm(streaming), true);
  assert.equal(hasUnterminatedQuestionForm(deploymentLocationFormText), false);
});

test('suppresses a partially streamed opening tag before its closing angle bracket arrives', () => {
  const streaming = 'The answer is almost ready.\n<question-fo';

  assert.deepEqual(splitOnQuestionForms(streaming), [
    { kind: 'text', text: 'The answer is almost ready.\n' },
  ]);
  assert.deepEqual(stripTrailingOpenQuestionForm(streaming), {
    text: 'The answer is almost ready.\n',
    hadOpenForm: true,
  });
});

const answerForm: QuestionForm = {
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
    {
      id: 'features',
      label: 'Features',
      type: 'checkbox',
      options: [
        { label: 'Logs', value: 'logs' },
        { label: 'Metrics', value: 'metrics' },
      ],
    },
  ],
};

test('formats answer markers with labels and distinct machine values', () => {
  assert.equal(
    formatFormAnswers(answerForm, { location: 'local', features: ['logs', 'metrics'] }),
    '[form answers — deployment-location]\n' +
      '- Choose one: Locally on this computer [value: local]\n' +
      '- Features: Logs [value: logs], Metrics [value: metrics]',
  );
});

test('parses answer markers back into an answer map and canonical summary', () => {
  const message =
    '[form answers - deployment-location]\n' +
    '- Choose one: Locally on this computer [value: local]\n' +
    '- Features: Logs, Metrics';
  const parsed = parseQuestionFormAnswerMarker(answerForm, message);

  assert.deepEqual(parsed, {
    formId: 'deployment-location',
    answers: { location: 'local', features: ['logs', 'metrics'] },
    summary: formatFormAnswers(answerForm, { location: 'local', features: ['logs', 'metrics'] }),
  });
  assert.deepEqual(parseFormAnswers(answerForm, message), {
    location: 'local',
    features: ['logs', 'metrics'],
  });
  assert.deepEqual(parseFormAnswerMarker(answerForm, message)?.answers, {
    location: 'local',
    features: ['logs', 'metrics'],
  });
});
