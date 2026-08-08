import { Check, CircleHelp, Loader2 } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import type {
  QuestionForm,
  QuestionFormAnswer,
  QuestionFormAnswers,
  QuestionFormOption,
  QuestionFormQuestion,
} from '../../types/types';

import {
  buildInitialQuestionFormAnswers,
  createQuestionFormSubmission,
  formatQuestionFormAnswerForSummary,
  isQuestionFormSubmissionAccepted,
  isQuestionFormValid,
} from './QuestionFormCard.utils';

/** The payload passed to the chat container when a form is accepted. */
export interface QuestionFormSubmission {
  form: QuestionForm;
  formId: string;
  answers: QuestionFormAnswers;
  /** A normal user-message body suitable for the existing chat send path. */
  message: string;
}

/**
 * Returning `false` keeps the form editable. Any other return value, including
 * `undefined`, accepts the submission. Promise-returning callbacks are awaited
 * so the card can prevent a second send while the chat pipeline starts.
 */
export type QuestionFormSubmitResult = boolean | void | Promise<boolean | void>;

export type QuestionFormSubmitHandler = (
  submission: QuestionFormSubmission,
) => QuestionFormSubmitResult;

export interface QuestionFormCardProps {
  form: QuestionForm;
  onSubmit: QuestionFormSubmitHandler;
  /** Optional draft values supplied by an embedding chat surface. */
  initialAnswers?: QuestionFormAnswers;
  /** When present, render the locked summary instead of the interactive card. */
  submittedAnswers?: QuestionFormAnswers;
  disabled?: boolean;
  className?: string;
}

export interface QuestionFormSummaryProps {
  form: QuestionForm;
  answers: QuestionFormAnswers;
  className?: string;
}

const SUBMIT_ERROR = 'The answers could not be sent. Please try again.';

/**
 * Compact, locked transcript representation for a form that has already been
 * answered. This component is intentionally independent from chat history;
 * TODO 5 can derive `answers` with the parser's answer-marker helper.
 */
export function QuestionFormSummary({
  form,
  answers,
  className = '',
}: QuestionFormSummaryProps) {
  return (
    <section
      aria-label={`Answered form: ${form.title}`}
      data-form-id={form.id}
      data-question-form-summary
      className={`w-full max-w-2xl rounded-xl border border-border/60 bg-card/70 px-4 py-3 shadow-sm ${className}`.trim()}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
          <Check className="h-4 w-4" strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold text-foreground">{form.title}</h3>
            <span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              Answered
            </span>
          </div>
          <dl className="mt-2 space-y-1.5">
            {form.questions.map((question) => (
              <div key={question.id} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 text-xs sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <dt className="truncate font-medium text-muted-foreground" title={question.label}>
                  {question.label}
                </dt>
                <dd className="break-words text-foreground/90">
                  {formatQuestionFormAnswerForSummary(question, answers[question.id])}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

/**
 * Accessible native-control card for an inline `<question-form>` artifact.
 * The component owns only draft/submission UI state. The parent owns chat
 * transport and can return a Promise or `false` to control acceptance.
 */
export function QuestionFormCard({
  form,
  onSubmit,
  initialAnswers,
  submittedAnswers,
  disabled = false,
  className = '',
}: QuestionFormCardProps) {
  const [answers, setAnswers] = useState<QuestionFormAnswers>(() =>
    buildInitialQuestionFormAnswers(form, initialAnswers),
  );
  const [locallySubmittedAnswers, setLocallySubmittedAnswers] = useState<QuestionFormAnswers | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const previousFormIdRef = useRef(form.id);

  useEffect(() => {
    if (previousFormIdRef.current === form.id) return;
    previousFormIdRef.current = form.id;
    setAnswers(buildInitialQuestionFormAnswers(form, initialAnswers));
    setLocallySubmittedAnswers(null);
    setSubmitError(null);
  }, [form, form.id, initialAnswers]);

  const acceptedAnswers = submittedAnswers ?? locallySubmittedAnswers;
  if (acceptedAnswers) {
    return <QuestionFormSummary form={form} answers={acceptedAnswers} className={className} />;
  }

  const valid = isQuestionFormValid(form, answers);
  const controlsDisabled = disabled || isSubmitting;

  function updateAnswer(question: QuestionFormQuestion, answer: QuestionFormAnswer) {
    setAnswers((current) => ({ ...current, [question.id]: answer }));
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (controlsDisabled || !valid || submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    const submission = createQuestionFormSubmission(form, answers);

    try {
      const result = await onSubmit(submission);
      if (isQuestionFormSubmissionAccepted(result)) {
        setLocallySubmittedAnswers(submission.answers);
      } else {
        setSubmitError(SUBMIT_ERROR);
      }
    } catch {
      setSubmitError(SUBMIT_ERROR);
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  const titleId = `question-form-title-${form.id}`;
  const descriptionId = form.description ? `question-form-description-${form.id}` : undefined;

  return (
    <form
      aria-busy={isSubmitting}
      aria-labelledby={titleId}
      data-form-id={form.id}
      data-question-form-card
      lang={form.lang}
      onSubmit={handleSubmit}
      className={`relative w-full max-w-2xl overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm ${className}`.trim()}
    >
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary via-cyan-400 to-teal-400" aria-hidden />
      <header className="flex items-start gap-3 border-b border-border/50 px-4 py-4 sm:px-5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden>
          <CircleHelp className="h-4.5 w-4.5" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold tracking-tight text-foreground">{form.title}</h2>
          {form.description ? (
            <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {form.description}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 rounded-full border border-border/70 bg-muted/40 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Questions
        </span>
      </header>

      <div className="space-y-5 px-4 py-5 sm:px-5">
        {form.questions.map((question) => (
          <QuestionField
            key={question.id}
            form={form}
            question={question}
            value={answers[question.id]}
            disabled={controlsDisabled}
            descriptionId={descriptionId}
            onChange={(answer) => updateAnswer(question, answer)}
          />
        ))}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 bg-muted/20 px-4 py-3 sm:px-5">
        <div className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
          {submitError ? <span className="text-destructive">{submitError}</span> : 'Your answers will be sent as the next chat message.'}
        </div>
        <button
          type="submit"
          disabled={controlsDisabled || !valid}
          className="inline-flex min-w-24 items-center justify-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          <span>{isSubmitting ? 'Sending…' : form.submitLabel ?? 'Submit answers'}</span>
        </button>
      </footer>
    </form>
  );
}

interface QuestionFieldProps {
  form: QuestionForm;
  question: QuestionFormQuestion;
  value: QuestionFormAnswer | undefined;
  disabled: boolean;
  descriptionId?: string;
  onChange: (answer: QuestionFormAnswer) => void;
}

function QuestionField({
  form,
  question,
  value,
  disabled,
  descriptionId,
  onChange,
}: QuestionFieldProps) {
  const controlId = questionControlId(form.id, question.id);
  const hintId = question.description || question.help ? `${controlId}-hint` : undefined;
  const describedBy = [descriptionId, hintId].filter(Boolean).join(' ') || undefined;
  const questionType = question.type as string;

  const fieldLabel = (
    <>
      <span>{question.label}</span>
      {question.required ? (
        <span className="ml-1.5 font-medium text-primary" title="Required" aria-label="Required">*</span>
      ) : null}
    </>
  );

  const fieldHelp = question.description || question.help ? (
    <div id={hintId} className="mt-1.5 space-y-1 text-xs leading-relaxed text-muted-foreground">
      {question.description ? <p>{question.description}</p> : null}
      {question.help ? <p>{question.help}</p> : null}
    </div>
  ) : null;

  const options = question.options ?? [];
  const selectedValues = Array.isArray(value) ? value : [];

  if (questionType === 'radio' && options.length > 0) {
    return (
      <fieldset className="space-y-2" aria-describedby={describedBy}>
        <legend className="text-sm font-medium text-foreground">{fieldLabel}</legend>
        <div className="space-y-2" role="radiogroup" aria-label={question.label}>
          {options.map((option, optionIndex) => (
            <OptionLabel
              key={option.value}
              option={option}
              selected={value === option.value}
              disabled={disabled}
            >
              <input
                type="radio"
                id={`${controlId}-${optionIndex}`}
                name={controlId}
                value={option.value}
                checked={value === option.value}
                required={question.required && optionIndex === 0}
                disabled={disabled}
                onChange={() => onChange(option.value)}
              />
            </OptionLabel>
          ))}
        </div>
        {fieldHelp}
      </fieldset>
    );
  }

  if (questionType === 'checkbox' && options.length > 0) {
    return (
      <fieldset className="space-y-2" aria-describedby={describedBy}>
        <legend className="text-sm font-medium text-foreground">{fieldLabel}</legend>
        <div className="space-y-2" aria-label={question.label}>
          {options.map((option, optionIndex) => {
            const checked = selectedValues.includes(option.value);
            return (
              <OptionLabel key={option.value} option={option} selected={checked} disabled={disabled}>
                <input
                  type="checkbox"
                  id={`${controlId}-${optionIndex}`}
                  name={controlId}
                  value={option.value}
                  checked={checked}
                  required={question.required && optionIndex === 0}
                  disabled={disabled}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...selectedValues, option.value]
                      : selectedValues.filter((selected) => selected !== option.value);
                    onChange(next);
                  }}
                />
              </OptionLabel>
            );
          })}
        </div>
        {fieldHelp}
      </fieldset>
    );
  }

  if (questionType === 'select' && options.length > 0) {
    const selected = typeof value === 'string' ? value : '';
    return (
      <div className="space-y-2">
        <label htmlFor={controlId} className="block text-sm font-medium text-foreground">{fieldLabel}</label>
        <select
          id={controlId}
          name={question.id}
          value={selected}
          required={question.required}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground shadow-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="" disabled>{question.placeholder ?? 'Choose an option'}</option>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {fieldHelp}
      </div>
    );
  }

  if (questionType === 'textarea') {
    return (
      <div className="space-y-2">
        <label htmlFor={controlId} className="block text-sm font-medium text-foreground">{fieldLabel}</label>
        <textarea
          id={controlId}
          name={question.id}
          value={typeof value === 'string' ? value : ''}
          placeholder={question.placeholder}
          required={question.required}
          disabled={disabled}
          aria-describedby={describedBy}
          rows={4}
          onChange={(event) => onChange(event.target.value)}
          className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60"
        />
        {fieldHelp}
      </div>
    );
  }

  // The normal text case and every unknown runtime type intentionally share
  // this safe fallback. Unsupported protocol values never reach the DOM as
  // raw JSON or custom markup.
  return (
    <div className="space-y-2">
      <label htmlFor={controlId} className="block text-sm font-medium text-foreground">{fieldLabel}</label>
      <input
        id={controlId}
        name={question.id}
        type="text"
        value={typeof value === 'string' ? value : ''}
        placeholder={question.placeholder}
        required={question.required}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60"
      />
      {fieldHelp}
    </div>
  );
}

function OptionLabel({
  option,
  selected,
  disabled,
  children,
}: {
  option: QuestionFormOption;
  selected: boolean;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-ring/30 ${selected ? 'border-primary/50 bg-primary/5' : 'border-border/70 bg-background/50 hover:border-primary/30 hover:bg-muted/30'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
      <span className="mt-0.5 shrink-0">{children}</span>
      <span className="min-w-0">
        <span className="block text-sm text-foreground">{option.label}</span>
        {option.description ? <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{option.description}</span> : null}
      </span>
    </label>
  );
}

function questionControlId(formId: string, questionId: string): string {
  const safePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `question-form-${safePart(formId)}-${safePart(questionId)}`;
}
