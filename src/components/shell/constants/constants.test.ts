import assert from 'node:assert/strict';
import test from 'node:test';

import { getTerminalRendererPolicy } from './constants';

test('uses the built-in renderer and disables cursor redraws for inactive shells', () => {
  assert.deepEqual(getTerminalRendererPolicy(false), {
    useWebgl: false,
    cursorBlink: false,
  });
});

test('keeps cursor feedback for explicitly active shells without enabling WebGL', () => {
  assert.deepEqual(getTerminalRendererPolicy(true), {
    useWebgl: false,
    cursorBlink: true,
  });
});
