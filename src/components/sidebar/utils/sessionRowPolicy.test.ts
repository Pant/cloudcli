import assert from 'node:assert/strict';
import test from 'node:test';

import { getSessionRowIndent, getSessionRowInteractionPolicy, MAX_SESSION_ROW_DEPTH } from './sessionRowPolicy';

test('keeps common nested rows indented and caps pathological depth', () => {
  assert.equal(getSessionRowIndent(0), 8);
  assert.equal(getSessionRowIndent(1), 24);
  assert.equal(getSessionRowIndent(2), 40);
  assert.equal(getSessionRowIndent(MAX_SESSION_ROW_DEPTH + 10), 8 + MAX_SESSION_ROW_DEPTH * 16);
});

test('parent rows select and toggle while disclosure is branch-only', () => {
  assert.deepEqual(getSessionRowInteractionPolicy(true), {
    selectsOnRowClick: true,
    togglesOnRowClick: true,
    disclosureStopsPropagation: true,
  });
  assert.deepEqual(getSessionRowInteractionPolicy(false), {
    selectsOnRowClick: true,
    togglesOnRowClick: false,
    disclosureStopsPropagation: true,
  });
});
