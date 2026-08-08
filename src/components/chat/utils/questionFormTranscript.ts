import type { ChatMessage, QuestionForm, QuestionFormAnswers } from '../types/types';

import { parseQuestionFormAnswerMarker, splitQuestionFormSegments } from './questionForms';

/**
 * Reconstruct a form's submitted state from the later transcript turns.
 * Answers are ordinary user messages, so the first later matching marker is
 * authoritative after a session reload.
 */
export function findSubsequentQuestionFormAnswers(
  form: QuestionForm,
  transcript: ChatMessage[],
  assistantMessageIndex: number,
): QuestionFormAnswers | null {
  if (assistantMessageIndex < 0 || assistantMessageIndex >= transcript.length) return null;

  for (let index = assistantMessageIndex + 1; index < transcript.length; index += 1) {
    const message = transcript[index];
    if (message?.type === 'assistant') {
      const repeatsForm = splitQuestionFormSegments(String(message.content || '')).some(
        (segment) => segment.kind === 'form'
          && segment.form.id.toLowerCase() === form.id.toLowerCase(),
      );
      if (repeatsForm) return null;
      continue;
    }
    if (message?.type !== 'user') continue;

    const parsed = parseQuestionFormAnswerMarker(form, String(message.content || ''));
    if (parsed?.formId?.toLowerCase() === form.id.toLowerCase()) {
      return parsed.answers;
    }
  }

  return null;
}
