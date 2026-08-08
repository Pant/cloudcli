import assert from 'node:assert/strict';
import test from 'node:test';

import { getControlledMarkdownLanguage } from './controlledLanguages';

test('maps all supported Markdown fence languages and aliases to controlled Prism grammars', () => {
  const expected = {
    js: 'javascript', javascript: 'javascript', jsx: 'jsx',
    ts: 'typescript', typescript: 'typescript', tsx: 'tsx', json: 'json',
    bash: 'bash', sh: 'bash', python: 'python', py: 'python', css: 'css',
    html: 'markup', markdown: 'markdown', md: 'markdown', yaml: 'yaml', yml: 'yaml', sql: 'sql',
  } as const;

  Object.entries(expected).forEach(([language, grammar]) => {
    assert.equal(getControlledMarkdownLanguage(language), grammar);
  });
});

test('leaves unknown and absent fence languages unregistered for plain-code fallback', () => {
  assert.equal(getControlledMarkdownLanguage('brainfuck'), undefined);
  assert.equal(getControlledMarkdownLanguage(undefined), undefined);
});
