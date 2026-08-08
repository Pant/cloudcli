import { lazy, Suspense, useState } from 'react';
import type { ComponentProps } from 'react';

import { copyTextToClipboard } from '../../../../../utils/clipboard';
import { useTheme } from '../../../../../contexts/useTheme';

const ControlledSyntaxHighlighter = lazy(() => import('../../../../markdown/ControlledSyntaxHighlighter'));

type MarkdownCodeBlockProps = {
  inline?: boolean;
  node?: unknown;
} & ComponentProps<'code'>;

export default function MarkdownCodeBlock({
  inline,
  className,
  children,
  node: _node,
  ...props
}: MarkdownCodeBlockProps) {
  const { isDarkMode } = useTheme();
  const [copied, setCopied] = useState(false);
  const rawContent = Array.isArray(children) ? children.join('') : String(children ?? '');
  const looksMultiline = /[\r\n]/.test(rawContent);
  const shouldRenderInline = inline || !looksMultiline;

  if (shouldRenderInline) {
    return (
      <code
        className={`whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-gray-100 px-1.5 py-0.5 font-mono text-[0.9em] text-gray-900 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100 ${className || ''}`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const languageMatch = /language-(\w+)/.exec(className || '');
  const language = languageMatch ? languageMatch[1] : undefined;

  return (
    <div className="group relative my-2">
      {language && (
        <div className="absolute left-3 top-2 z-10 text-xs font-medium uppercase text-gray-400">{language}</div>
      )}

      <button
        type="button"
        onClick={() =>
          copyTextToClipboard(rawContent).then((success) => {
            if (success) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          })}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/90 px-2 py-1 text-xs text-foreground/80 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>

      <Suspense fallback={<pre className="m-0 overflow-x-auto rounded-xl bg-muted p-4 pt-8 text-sm"><code>{rawContent}</code></pre>}>
        <ControlledSyntaxHighlighter code={rawContent} language={language} isDarkMode={isDarkMode} />
      </Suspense>
    </div>
  );
}
