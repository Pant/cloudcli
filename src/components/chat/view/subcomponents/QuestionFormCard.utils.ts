import type {
  QuestionForm,
  QuestionFormAnswer,
  QuestionFormAnswers,
  QuestionFormQuestion,
} from '../../types/types';
import {
  formOptionLabelForValue,
  formatFormAnswers,
} from '../../utils/questionForms';

const EMPTY_ANSWER_LABEL = 'Not answered';

/**
 * Build the controlled answer map used by the card. Form defaults are only
 * initial values; changing a control still comes through the normal input
 * events and the callback receives the complete map.
 */
export function buildInitialQuestionFormAnswers(
  form: QuestionForm,
  initialAnswers?: QuestionFormAnswers,
): QuestionFormAnswers {
  return Object.fromEntries(
    form.questions.map((question) => {
      const supplied = initialAnswers?.[question.id];
      const value = supplied !== undefined
        ? normalizeAnswerForQuestion(question, supplied)
        : question.defaultValue !== undefined
          ? normalizeAnswerForQuestion(question, question.defaultValue)
          : emptyAnswerForQuestion(question);
      return [question.id, value];
    }),
  );
}

/** Required validation shared by the button state and the native form path. */
export function isQuestionFormValid(
  form: QuestionForm,
  answers: QuestionFormAnswers,
): boolean {
  return form.questions.every((question) => {
    if (!question.required) return true;
    return answerIsPresent(question, answers[question.id]);
  });
}

/** Create the stable normal-message payload consumed by TODO 5. */
export function createQuestionFormSubmission(
  form: QuestionForm,
  answers: QuestionFormAnswers,
): {
  form: QuestionForm;
  formId: string;
  answers: QuestionFormAnswers;
  message: string;
} {
  const normalizedAnswers = copyAnswers(answers);
  return {
    form,
    formId: form.id,
    answers: normalizedAnswers,
    message: formatFormAnswers(form, normalizedAnswers),
  };
}

export function isQuestionFormSubmissionAccepted(result: boolean | void): boolean {
  return result !== false;
}

/** Turn a submitted answer into the human-readable value used in the summary. */
export function formatQuestionFormAnswerForSummary(
  question: QuestionFormQuestion,
  answer: QuestionFormAnswer | undefined,
): string {
  const values = Array.isArray(answer) ? answer : answer === undefined ? [] : [answer];
  const nonEmptyValues = values.filter((value) => value.trim().length > 0);
  if (nonEmptyValues.length === 0) return EMPTY_ANSWER_LABEL;

  return nonEmptyValues
    .map((value) => value.toLowerCase() === '(skipped)'
      ? 'Skipped'
      : formOptionLabelForValue(question, value))
    .join(', ');
}

function emptyAnswerForQuestion(question: QuestionFormQuestion): QuestionFormAnswer {
  return question.type === 'checkbox' && (question.options?.length ?? 0) > 0 ? [] : '';
}

function normalizeAnswerForQuestion(
  question: QuestionFormQuestion,
  answer: QuestionFormAnswer,
): QuestionFormAnswer {
  if (question.type === 'checkbox' && (question.options?.length ?? 0) > 0) {
    const values = Array.isArray(answer) ? answer : [answer];
    return values
      .filter((value) => value.trim().length > 0)
      .map((value) => question.options?.find((option) => option.value === value || option.label === value)?.value ?? value);
  }

  const value = Array.isArray(answer) ? answer[0] ?? '' : answer;
  return question.options?.find((option) => option.value === value || option.label === value)?.value ?? value;
}

function answerIsPresent(
  question: QuestionFormQuestion,
  answer: QuestionFormAnswer | undefined,
): boolean {
  if (question.type === 'checkbox' && (question.options?.length ?? 0) > 0) {
    return Array.isArray(answer) && answer.some((value) => value.trim().length > 0);
  }
  return typeof answer === 'string' && answer.trim().length > 0;
}

function copyAnswers(answers: QuestionFormAnswers): QuestionFormAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  );
}
