import type {
  QuestionForm,
  QuestionFormAnswer,
  QuestionFormAnswers,
  QuestionFormOption,
  QuestionFormQuestion,
  QuestionFormQuestionType,
  QuestionFormSegment,
} from '../types/types';

const INVALID_QUESTION_FORM_FALLBACK =
  'The assistant sent a question form that could not be rendered. Please ask it to resend the questions.';

const OPEN_TAG_RE = /<(question-form|ask-question)\b([^>]*)>/gi;

export interface ParsedQuestionFormAnswers {
  formId: string | null;
  answers: QuestionFormAnswers;
  summary: string;
}

/**
 * Split assistant text into ordinary prose and explicitly supported form
 * blocks. This parser deliberately does not enable raw HTML in Markdown.
 *
 * A complete block with invalid JSON is replaced with a safe fallback. An
 * unterminated block is treated as streaming output and its suffix is hidden
 * so partial tags or JSON never reach the Markdown renderer.
 */
export function splitQuestionFormSegments(input: string): QuestionFormSegment[] {
  const segments: QuestionFormSegment[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const opening = findNextOpeningTag(input, cursor);
    if (!opening) {
      const partialOpeningStart = findTrailingPartialOpeningTag(input, cursor);
      pushTextSegment(
        segments,
        partialOpeningStart === null ? input.slice(cursor) : input.slice(cursor, partialOpeningStart),
      );
      break;
    }

    pushTextSegment(segments, input.slice(cursor, opening.start));

    const closing = findClosingTag(input, opening.end, opening.tagName);
    if (!closing) {
      // This is the incomplete trailing streaming form. The prose already
      // emitted above is retained, while the partial form suffix is omitted.
      break;
    }

    const raw = input.slice(opening.start, closing.end);
    const body = input.slice(opening.end, closing.start);
    const form = parseCompletedQuestionForm(body, parseAttributes(opening.attributes));
    if (form) {
      segments.push({ kind: 'form', form, raw });
    } else {
      segments.push({ kind: 'fallback', text: INVALID_QUESTION_FORM_FALLBACK });
    }
    cursor = closing.end;
  }

  return segments;
}

/** Compatibility name matching the protocol's reference implementation. */
export const splitOnQuestionForms = splitQuestionFormSegments;
export const parseQuestionFormSegments = splitQuestionFormSegments;

export function parseQuestionForm(input: string): QuestionForm | null {
  return findFirstQuestionForm(input)?.form ?? null;
}

export function findFirstQuestionForm(
  input: string,
): { form: QuestionForm; raw: string } | null {
  const segment = splitQuestionFormSegments(input).find((item) => item.kind === 'form');
  return segment?.kind === 'form' ? { form: segment.form, raw: segment.raw } : null;
}

/**
 * Remove an open form suffix from streaming assistant text without parsing
 * or otherwise changing any completed content before it.
 */
export function stripTrailingOpenQuestionForm(
  input: string,
): { text: string; hadOpenForm: boolean } {
  let cursor = 0;

  while (cursor < input.length) {
    const opening = findNextOpeningTag(input, cursor);
    if (!opening) {
      const partialOpeningStart = findTrailingPartialOpeningTag(input, cursor);
      return partialOpeningStart === null
        ? { text: input, hadOpenForm: false }
        : { text: input.slice(0, partialOpeningStart), hadOpenForm: true };
    }

    const closing = findClosingTag(input, opening.end, opening.tagName);
    if (!closing) return { text: input.slice(0, opening.start), hadOpenForm: true };
    cursor = closing.end;
  }

  return { text: input, hadOpenForm: false };
}

export function hasUnterminatedQuestionForm(input: string): boolean {
  return stripTrailingOpenQuestionForm(input).hadOpenForm;
}

/**
 * Format answers as a normal user message. Option labels remain readable and
 * machine values are retained whenever an option has a distinct value.
 */
export function formatFormAnswers(form: QuestionForm, answers: QuestionFormAnswers): string {
  const lines = [`[form answers — ${form.id}]`];

  for (const question of form.questions) {
    const answer = answers[question.id];
    const display = formatQuestionAnswer(question, answer);
    lines.push(`- ${question.label}: ${display}`);
  }

  return lines.join('\n');
}

/**
 * Parse a previously formatted answer message back into the stable answer
 * map used by the form. The returned summary is canonicalized through the
 * formatter, which makes it suitable for compact answered-state rendering.
 */
export function parseQuestionFormAnswerMarker(
  form: QuestionForm,
  userMessageContent: string,
): ParsedQuestionFormAnswers | null {
  const lines = userMessageContent.split(/\r?\n/).map((line) => line.trim());
  const header = lines.find((line) => line.length > 0);
  if (!header) return null;

  const marker = parseAnswerHeader(header);
  if (!marker) return null;

  const answers: QuestionFormAnswers = {};
  for (const line of lines.slice(lines.indexOf(header) + 1)) {
    const parsedLine = parseAnswerLine(line, form.questions);
    if (!parsedLine) continue;
    answers[parsedLine.question.id] = parsedLine.answer;
  }

  return {
    formId: marker.formId,
    answers,
    summary: formatFormAnswers(form, answers),
  };
}

/** Return only the answer map for callers matching the existing form API. */
export function parseFormAnswers(
  form: QuestionForm,
  userMessageContent: string,
): QuestionFormAnswers | null {
  const parsed = parseQuestionFormAnswerMarker(form, userMessageContent);
  return parsed && Object.keys(parsed.answers).length > 0 ? parsed.answers : null;
}

/** Compatibility aliases for callers that use the protocol terminology. */
export const parseSubmittedAnswers = parseFormAnswers;
export const parseSubmittedQuestionFormAnswers = parseQuestionFormAnswerMarker;
export const parseFormAnswerMarker = parseQuestionFormAnswerMarker;
export const parseQuestionFormAnswers = parseFormAnswers;

export function formOptionLabelForValue(
  question: Pick<QuestionFormQuestion, 'options'>,
  value: string,
): string {
  return findOption(question.options, value)?.label ?? value;
}

export function formOptionValueForLabel(
  question: Pick<QuestionFormQuestion, 'options'>,
  labelOrValue: string,
): string {
  return findOption(question.options, labelOrValue)?.value ?? labelOrValue;
}

function findNextOpeningTag(
  input: string,
  from: number,
): { start: number; end: number; tagName: string; attributes: string } | null {
  OPEN_TAG_RE.lastIndex = from;
  const match = OPEN_TAG_RE.exec(input);
  if (!match || match.index === undefined) return null;

  return {
    start: match.index,
    end: match.index + match[0].length,
    tagName: (match[1] ?? 'question-form').toLowerCase(),
    attributes: match[2] ?? '',
  };
}

function findTrailingPartialOpeningTag(input: string, from: number): number | null {
  const start = input.lastIndexOf('<');
  if (start < from) return null;

  const suffix = input.slice(start).toLowerCase();
  const tagPrefixes = ['<question-form', '<ask-question'];
  return tagPrefixes.some(
    (prefix) => prefix.startsWith(suffix) || (suffix.startsWith(prefix) && !suffix.includes('>')),
  )
    ? start
    : null;
}

function findClosingTag(
  input: string,
  from: number,
  tagName: string,
): { start: number; end: number } | null {
  const closePattern = new RegExp(`</${escapeRegExp(tagName)}\\s*>`, 'ig');
  closePattern.lastIndex = from;
  const match = closePattern.exec(input);
  if (!match || match.index === undefined) return null;
  return { start: match.index, end: match.index + match[0].length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pushTextSegment(segments: QuestionFormSegment[], text: string): void {
  if (text.length > 0) segments.push({ kind: 'text', text });
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(raw)) !== null) {
    const key = (match[1] ?? '').toLowerCase();
    if (key.length > 0) attributes[key] = match[2] ?? match[3] ?? '';
  }

  return attributes;
}

function parseCompletedQuestionForm(
  rawBody: string,
  attributes: Record<string, string>,
): QuestionForm | null {
  const json = stripJsonFence(rawBody.trim());
  if (json.length === 0) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(json) as unknown;
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;

  const payloadObject = Array.isArray(payload)
    ? null
    : (payload as Record<string, unknown>);
  const rawQuestions = Array.isArray(payload)
    ? payload
    : payloadObject && Array.isArray(payloadObject.questions)
      ? payloadObject.questions
      : null;
  if (!rawQuestions) return null;

  const questions = rawQuestions
    .map((question, index) => normalizeQuestion(question, index))
    .filter((question): question is QuestionFormQuestion => question !== null);
  if (questions.length === 0) return null;

  const id = firstNonEmptyString(attributes.id, payloadObject?.id) ?? 'discovery';
  const title =
    firstNonEmptyString(attributes.title, payloadObject?.title) ?? 'A few quick questions';
  const description = stringValue(payloadObject?.description);
  const submitLabel = stringValue(payloadObject?.submitLabel);
  const lang = stringValue(payloadObject?.lang);

  return {
    id,
    title,
    questions,
    ...(description ? { description } : {}),
    ...(submitLabel ? { submitLabel } : {}),
    ...(lang ? { lang } : {}),
  };
}

function stripJsonFence(body: string): string {
  return body
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function normalizeQuestion(raw: unknown, index: number): QuestionFormQuestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const question = raw as Record<string, unknown>;
  const id = firstNonEmptyString(question.id) ?? `q${index + 1}`;
  const label = firstNonEmptyString(question.label, question.prompt, question.question) ?? id;
  const options = normalizeOptions(question.options);
  const type = normalizeQuestionType(question.type, options);
  const defaultValue = normalizeDefaultValue(question, options);
  const description = stringValue(question.description);
  const help = stringValue(question.help);
  const placeholder = stringValue(question.placeholder);

  return {
    id,
    label,
    type,
    ...(options ? { options } : {}),
    ...(description ? { description } : {}),
    ...(help ? { help } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(question.required === true ? { required: true } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}

function normalizeOptions(raw: unknown): QuestionFormOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const options = raw
    .map((option) => normalizeOption(option))
    .filter((option): option is QuestionFormOption => option !== null);
  return options.length > 0 ? options : undefined;
}

function normalizeOption(raw: unknown): QuestionFormOption | null {
  if (typeof raw === 'string') {
    const label = raw.trim();
    return label.length > 0 ? { label, value: label } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const option = raw as Record<string, unknown>;
  const label = stringValue(option.label);
  if (!label) return null;

  const value =
    stringValue(option.value) ?? stringValue(option.id) ?? label;
  const description = stringValue(option.description);
  return {
    label,
    value,
    ...(description ? { description } : {}),
  };
}

function normalizeQuestionType(
  raw: unknown,
  options: QuestionFormOption[] | undefined,
): QuestionFormQuestionType {
  if (typeof raw !== 'string') return options && options.length > 0 ? 'radio' : 'text';

  switch (raw.trim().toLowerCase()) {
    case 'radio':
    case 'single':
    case 'choice':
      return 'radio';
    case 'checkbox':
    case 'multi':
    case 'multiple':
      return 'checkbox';
    case 'select':
    case 'dropdown':
      return 'select';
    case 'textarea':
    case 'long':
    case 'paragraph':
      return 'textarea';
    case 'text':
      return 'text';
    default:
      // TODO 3 can render this normalized text fallback safely instead of
      // exposing an unsupported protocol type or its raw JSON.
      return 'text';
  }
}

function normalizeDefaultValue(
  question: Record<string, unknown>,
  options: QuestionFormOption[] | undefined,
): QuestionFormAnswer | undefined {
  const defaultValue = normalizeAnswerInput(question.defaultValue);
  const defaultAnswer = normalizeAnswerInput(question.default);
  const values = defaultValue !== undefined ? defaultValue : defaultAnswer;
  if (values === undefined) return undefined;

  if (Array.isArray(values)) {
    return values.map((value) => normalizeOptionValue(options, value));
  }
  return normalizeOptionValue(options, values);
}

function normalizeAnswerInput(raw: unknown): QuestionFormAnswer | undefined {
  if (Array.isArray(raw)) {
    const values = raw
      .map((value) => scalarString(value))
      .filter((value): value is string => value !== undefined);
    return values;
  }
  return scalarString(raw);
}

function scalarString(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return undefined;
}

function normalizeOptionValue(options: QuestionFormOption[] | undefined, value: string): string {
  return findOption(options, value)?.value ?? value;
}

function findOption(
  options: QuestionFormOption[] | undefined,
  value: string,
): QuestionFormOption | undefined {
  return options?.find((option) => option.value === value || option.label === value);
}

function formatQuestionAnswer(
  question: QuestionFormQuestion,
  answer: QuestionFormAnswer | undefined,
): string {
  if (Array.isArray(answer)) {
    return answer.length > 0
      ? answer.map((value) => formatOptionValue(question, value)).join(', ')
      : '(skipped)';
  }
  if (typeof answer !== 'string' || answer.trim().length === 0) return '(skipped)';
  return formatOptionValue(question, answer.trim());
}

function formatOptionValue(question: QuestionFormQuestion, value: string): string {
  const option = findOption(question.options, value);
  if (!option) return value;
  return option.label === option.value
    ? option.label
    : `${option.label} [value: ${option.value}]`;
}

function parseAnswerHeader(header: string): { formId: string | null } | null {
  const match = /^\[form answers\b([^\]]*)\]$/i.exec(header);
  if (!match) return null;

  const suffix = (match[1] ?? '')
    .trim()
    .replace(/^(?:—+|-+|:)\s*/, '')
    .replace(/^(?:for|about)\s+/i, '')
    .trim();
  return { formId: suffix.length > 0 ? suffix : null };
}

function parseAnswerLine(
  line: string,
  questions: QuestionFormQuestion[],
): { question: QuestionFormQuestion; answer: QuestionFormAnswer } | null {
  const match = /^[-*]\s*(.+?)\s*:\s*(.*)$/.exec(line);
  if (!match) return null;

  const key = (match[1] ?? '').trim().toLowerCase();
  const rawValue = (match[2] ?? '').trim();
  const question = questions.find(
    (candidate) => candidate.label.toLowerCase() === key || candidate.id.toLowerCase() === key,
  );
  if (!question) return null;

  if (question.type === 'checkbox') {
    if (rawValue.toLowerCase() === '(skipped)') return { question, answer: [] };
    const values = rawValue
      .split(',')
      .map((value) => parseSubmittedOptionToken(value))
      .map((value) => formOptionValueForLabel(question, value))
      .filter((value) => value.length > 0 && value.toLowerCase() !== '(skipped)');
    return { question, answer: values };
  }

  if (rawValue.toLowerCase() === '(skipped)') return { question, answer: '' };
  const value = formOptionValueForLabel(question, parseSubmittedOptionToken(rawValue));
  return { question, answer: value };
}

function parseSubmittedOptionToken(raw: string): string {
  const match = /\s+\[value:\s*([^\]]+)\]\s*$/i.exec(raw);
  return match?.[1]?.trim() ?? raw.trim();
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return firstNonEmptyString(value);
}
