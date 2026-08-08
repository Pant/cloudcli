import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { getControlledMarkdownLanguage } from './controlledLanguages';

const languages = {
  bash,
  css,
  javascript,
  json,
  jsx,
  markdown,
  markup,
  python,
  sql,
  tsx,
  typescript,
  yaml,
};

Object.entries(languages).forEach(([name, grammar]) => SyntaxHighlighter.registerLanguage(name, grammar));

type ControlledSyntaxHighlighterProps = {
  code: string;
  language?: string;
  isDarkMode: boolean;
};

export default function ControlledSyntaxHighlighter({
  code,
  language,
  isDarkMode,
}: ControlledSyntaxHighlighterProps) {
  const controlledLanguage = getControlledMarkdownLanguage(language);

  if (!controlledLanguage) {
    return (
      <pre className="m-0 overflow-x-auto rounded-xl bg-muted p-4 pt-8 text-sm text-foreground">
        <code className="font-mono">{code}</code>
      </pre>
    );
  }

  return (
    <SyntaxHighlighter
      language={controlledLanguage}
      style={isDarkMode ? oneDark : oneLight}
      customStyle={{
        margin: 0,
        borderRadius: '0.75rem',
        fontSize: '0.875rem',
        padding: '2rem 1rem 1rem 1rem',
        ...(isDarkMode ? {} : { background: 'hsl(var(--muted))' }),
      }}
      codeTagProps={{
        style: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          ...(isDarkMode ? {} : { background: 'transparent' }),
        },
      }}
    >
      {code}
    </SyntaxHighlighter>
  );
}
