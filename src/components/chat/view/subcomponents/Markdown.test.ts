import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { hasMarkdownMath } from './markdownMathDetection';
import { StreamingMarkdown } from './Markdown';

test('hasMarkdownMath loads math only for supported explicit delimiters', () => {
  assert.equal(hasMarkdownMath('price is $5 and escaped \\$10'), false);
  assert.equal(hasMarkdownMath('inline $x$ remains ordinary text'), false);
  assert.equal(hasMarkdownMath('display $$x^2$$'), true);
  assert.equal(hasMarkdownMath('inline \\(x^2\\)'), true);
  assert.equal(hasMarkdownMath('display \\[x^2\\]'), true);
});

test('streaming markdown preserves plain text, whitespace, and punctuation without rich markup', () => {
  const content = 'Hello **still plain**\n\n  indented';
  const html = renderToStaticMarkup(React.createElement(StreamingMarkdown, null, content));

  assert.match(html, /data-streaming-markdown="plain"/);
  assert.match(html, /Hello \*\*still plain\*\*/);
  assert.equal(html.includes('\n\n  indented'), true);
  assert.doesNotMatch(html, /<strong>/);
});

test('streaming markdown presents closed and unterminated fenced code readably', () => {
  const closed = renderToStaticMarkup(React.createElement(
    StreamingMarkdown,
    null,
    'before\n```ts\nconst x = 1;\n```\nafter',
  ));
  const open = renderToStaticMarkup(React.createElement(StreamingMarkdown, null, '```js\nconst open = true;'));

  assert.match(closed, /before/);
  assert.match(closed, />ts</);
  assert.match(closed, /const x = 1;/);
  assert.match(closed, /after/);
  assert.match(open, />js</);
  assert.match(open, /const open = true;/);
  assert.doesNotMatch(open, /```/);
});
