import assert from 'node:assert/strict';
import test from 'node:test';

import { hasMarkdownMath } from './markdownMathDetection';

test('hasMarkdownMath loads math only for supported explicit delimiters', () => {
  assert.equal(hasMarkdownMath('price is $5 and escaped \\$10'), false);
  assert.equal(hasMarkdownMath('inline $x$ remains ordinary text'), false);
  assert.equal(hasMarkdownMath('display $$x^2$$'), true);
  assert.equal(hasMarkdownMath('inline \\(x^2\\)'), true);
  assert.equal(hasMarkdownMath('display \\[x^2\\]'), true);
});
