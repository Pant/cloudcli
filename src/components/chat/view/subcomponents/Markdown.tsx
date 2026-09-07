import React, { lazy, memo, Suspense, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';

import { normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { usePaletteOps } from '../../../../contexts/paletteOps';
import { useTheme } from '../../../../contexts/useTheme';

import { hasMarkdownMath } from './markdownMathDetection';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  /** Render single newlines as hard line breaks (for user-typed messages). */
  breaks?: boolean;
  /** Growing stream content keeps fenced code plain until its final commit. */
  isStreaming?: boolean;
};

type StreamingSegment = {
  kind: 'text' | 'code';
  content: string;
  language?: string;
};

function splitStreamingMarkdown(content: string): StreamingSegment[] {
  const segments: StreamingSegment[] = [];
  const fencePattern = /^```([^\r\n]*)\r?\n?/gm;
  let cursor = 0;
  let openFence: RegExpExecArray | null;

  while ((openFence = fencePattern.exec(content)) !== null) {
    if (openFence.index > cursor) {
      segments.push({ kind: 'text', content: content.slice(cursor, openFence.index) });
    }

    const codeStart = fencePattern.lastIndex;
    const closeFence = /^```\s*$/gm;
    closeFence.lastIndex = codeStart;
    const closeMatch = closeFence.exec(content);
    const codeEnd = closeMatch?.index ?? content.length;
    segments.push({
      kind: 'code',
      content: content.slice(codeStart, codeEnd),
      language: openFence[1].trim() || undefined,
    });
    cursor = closeMatch ? closeFence.lastIndex : content.length;
    fencePattern.lastIndex = cursor;
  }

  if (cursor < content.length || segments.length === 0) {
    segments.push({ kind: 'text', content: content.slice(cursor) });
  }

  return segments;
}

export function StreamingMarkdown({ children, className }: MarkdownProps) {
  const content = String(children ?? '');
  const segments = splitStreamingMarkdown(content);

  return (
    <div className={`${className ?? ''} whitespace-pre-wrap break-words`} data-streaming-markdown="plain">
      {segments.map((segment, index) => segment.kind === 'code' ? (
        <div key={index} className="relative my-2 overflow-hidden rounded-xl bg-muted font-mono text-sm text-foreground">
          {segment.language && (
            <div className="px-4 pt-2 text-xs font-medium uppercase text-gray-400">{segment.language}</div>
          )}
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words p-4"><code>{segment.content}</code></pre>
        </div>
      ) : (
        <span key={index}>{segment.content}</span>
      ))}
    </div>
  );
}

// Links to the wider web (or in-page anchors) keep normal browser navigation;
// everything else is treated as a workspace file reference.
const isExternalHref = (href?: string): boolean =>
  !!href && (/^(https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith('#'));

// Strip a trailing `:line` / `:line:col` suffix (e.g. `src/foo.ts:130`).
const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

// A usable file path contains a separator or a filename with an extension.
const looksLikeFilePath = (value?: string): value is string => {
  if (!value) {
    return false;
  }
  const cleaned = stripLineSuffix(value.trim());
  if (!cleaned || cleaned === '#') {
    return false;
  }
  return /[\\/]/.test(cleaned) || /\.[a-z0-9]+$/i.test(cleaned);
};

// Extract plain text from link children so a reference rendered only as link
// text (e.g. `[src/foo.ts]()` with an empty href) can still be opened.
const childrenToText = (children: React.ReactNode): string => {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join('');
  }
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
};

type CodeBlockProps = {
  node?: any;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
};

const ControlledSyntaxHighlighter = lazy(() => import('../../../markdown/ControlledSyntaxHighlighter'));

const CodeBlock = ({ node, inline, className, children, isStreaming, ...props }: CodeBlockProps & { isStreaming?: boolean }) => {
  const { t } = useTranslation('chat');
  const { isDarkMode } = useTheme();
  const [copied, setCopied] = useState(false);
  const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
  const looksMultiline = /[\r\n]/.test(raw);
  const inlineDetected = inline || (node && node.type === 'inlineCode');
  const shouldInline = inlineDetected || !looksMultiline;

  if (shouldInline) {
    return (
      <code
        className={`whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-gray-100 px-1.5 py-0.5 font-mono text-[0.9em] text-gray-900 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100 ${className || ''
          }`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : undefined;

  return (
    <div className="group relative my-2">
      {language && (
        <div className="absolute left-3 top-2 z-10 text-xs font-medium uppercase text-gray-400">{language}</div>
      )}

      <button
        type="button"
        onClick={() =>
          copyTextToClipboard(raw).then((success) => {
            if (success) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          })
        }
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/90 px-2 py-1 text-xs text-foreground/80 opacity-0 transition-opacity hover:bg-muted focus:opacity-100 active:opacity-100 group-hover:opacity-100"
        title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
        aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
      >
        {copied ? (
          <span className="flex items-center gap-1">
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            {t('codeBlock.copied')}
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
            </svg>
            {t('codeBlock.copy')}
          </span>
        )}
      </button>

      {isStreaming ? (
        <pre className="m-0 overflow-x-auto rounded-xl bg-muted p-4 pt-8 text-sm text-foreground"><code>{raw}</code></pre>
      ) : (
        <Suspense fallback={<pre className="m-0 overflow-x-auto rounded-xl bg-muted p-4 pt-8 text-sm"><code>{raw}</code></pre>}>
          <ControlledSyntaxHighlighter code={raw} language={language} isDarkMode={isDarkMode} />
        </Suspense>
      )}
    </div>
  );
};

const markdownComponents = {
  code: CodeBlock,
  // CodeBlock renders its own syntax-highlighted <pre>; this passthrough stops
  // react-markdown (and Tailwind Typography) from wrapping it in a second,
  // dark-themed <pre> shell that would frame the block.
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-l-4 border-gray-300 pl-4 italic text-gray-600 dark:border-gray-600 dark:text-gray-400">
      {children}
    </blockquote>
  ),
  p: ({ children }: { children?: React.ReactNode }) => <div className="mb-2 last:mb-0">{children}</div>,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-2 list-outside list-disc space-y-1 pl-5 marker:text-current last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-2 list-outside list-decimal space-y-1 pl-5 marker:text-current last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li className="[&>div:last-child]:mb-0 [&>div]:mb-1">{children}</li>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-gray-200 px-3 py-2 text-left text-sm font-semibold dark:border-gray-700">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-gray-200 px-3 py-2 align-top text-sm dark:border-gray-700">{children}</td>
  ),
};

const MathMarkdown = lazy(() => import('./MarkdownMath'));

function RichMarkdown({ children, className, breaks = false }: MarkdownProps) {
  const content = normalizeInlineCodeFences(String(children ?? ''));
  const useMath = hasMarkdownMath(content);
  const remarkPlugins = useMemo(
    () => (breaks
      ? [remarkGfm, remarkBreaks]
      : [remarkGfm]) as any,
    [breaks],
  );
  const { openFileInEditor } = usePaletteOps();

  const components = useMemo(
    () => ({
      ...markdownComponents,
      code: (props: CodeBlockProps) => <CodeBlock {...props} />,
      a: ({ href, children: linkChildren }: { href?: string; children?: React.ReactNode }) => {
        // Prefer the href when it is a real path; otherwise fall back to the
        // link text, since models often emit `[src/foo.ts]()` with an empty href.
        const linkText = childrenToText(linkChildren);
        const fileRef = looksLikeFilePath(href) ? href : looksLikeFilePath(linkText) ? linkText : undefined;

        if (fileRef && !isExternalHref(href)) {
          return (
            <a
              href={href || fileRef}
              className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400"
              onClick={(event) => {
                event.preventDefault();
                openFileInEditor(stripLineSuffix(fileRef));
              }}
            >
              {linkChildren}
            </a>
          );
        }

        return (
          <a
            href={href}
            className="text-blue-600 hover:underline dark:text-blue-400"
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkChildren}
          </a>
        );
      },
    }),
    [openFileInEditor],
  );

  if (useMath) {
    return <Suspense fallback={<div className={className}>{content}</div>}><MathMarkdown className={className} breaks={breaks} components={components}>{content}</MathMarkdown></Suspense>;
  }

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components as any}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownView(props: MarkdownProps) {
  return props.isStreaming ? <StreamingMarkdown {...props} /> : <RichMarkdown {...props} />;
}

export const Markdown = memo(MarkdownView);
