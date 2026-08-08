import assert from 'node:assert/strict';
import test from 'node:test';

import { getActivityLabel, getElapsedTimeParts } from './ActivityIndicator.utils';

test('keeps provider status text while removing trailing punctuation', () => {
  assert.equal(getActivityLabel('Deploying...', ['Thinking', 'Processing'], 12), 'Deploying');
});

test('rotates fallback status text every four elapsed seconds', () => {
  const actionWords = ['Thinking', 'Processing', 'Analyzing'];

  assert.equal(getActivityLabel(null, actionWords, 0), 'Thinking');
  assert.equal(getActivityLabel(null, actionWords, 3), 'Thinking');
  assert.equal(getActivityLabel(null, actionWords, 4), 'Processing');
  assert.equal(getActivityLabel(null, actionWords, 12), 'Thinking');
});

test('normalizes elapsed time into minutes and seconds without negative values', () => {
  assert.deepEqual(getElapsedTimeParts(-1), { minutes: 0, seconds: 0 });
  assert.deepEqual(getElapsedTimeParts(125.9), { minutes: 2, seconds: 5 });
});
