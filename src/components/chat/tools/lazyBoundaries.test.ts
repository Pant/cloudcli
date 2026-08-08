import assert from 'node:assert/strict';
import test from 'node:test';

import { isCommandPaletteShortcut } from '../../command-palette/shortcut';

import { getLazyToolRendererFamily } from './lazyToolFamilies';

test('selects only optional renderer families for lazy loading', () => {
  assert.equal(getLazyToolRendererFamily('Bash'), null);
  assert.equal(getLazyToolRendererFamily('Edit', 'diff'), 'diff');
  assert.equal(getLazyToolRendererFamily('TodoWrite', 'todo-list'), 'todo-list');
  assert.equal(getLazyToolRendererFamily('TaskList', 'task'), 'task');
  assert.equal(getLazyToolRendererFamily('AskUserQuestion', 'question-answer'), 'question-answer');
  assert.equal(getLazyToolRendererFamily('Task', 'markdown'), 'subagent-markdown');
  assert.equal(getLazyToolRendererFamily('Task', undefined, true), 'subagent');
  assert.equal(getLazyToolRendererFamily('ExitPlanMode'), 'plan');
});

test('recognizes the first command palette invocation shortcut without modifiers', () => {
  assert.equal(isCommandPaletteShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: 'k' }), true);
  assert.equal(isCommandPaletteShortcut({ ctrlKey: false, metaKey: true, shiftKey: false, altKey: false, key: 'K' }), true);
  assert.equal(isCommandPaletteShortcut({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: 'k' }), false);
});
