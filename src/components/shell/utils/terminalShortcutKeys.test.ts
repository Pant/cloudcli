import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_MOBILE_TERMINAL_MODIFIERS,
  getShortcutSequence,
  MOBILE_TERMINAL_SHORTCUTS,
  transformTerminalInput,
} from './terminalShortcutKeys';

const modifiers = (values: Partial<typeof EMPTY_MOBILE_TERMINAL_MODIFIERS>) => ({
  ...EMPTY_MOBILE_TERMINAL_MODIFIERS,
  ...values,
});
const key = (id: string) => {
  const shortcut = MOBILE_TERMINAL_SHORTCUTS.find((item) => item.id === id);
  assert.ok(shortcut && shortcut.type === 'key');
  return shortcut;
};

test('defines standard terminal key sequences', () => {
  assert.equal(key('esc').sequence, '\x1b');
  assert.equal(key('tab').sequence, '\t');
  assert.equal(key('up').sequence, '\x1b[A');
  assert.equal(key('home').sequence, '\x1b[H');
  assert.equal(key('delete').sequence, '\x1b[3~');
  assert.equal(key('enter').sequence, '\r');
  assert.equal(key('backspace').sequence, '\x7f');
  assert.equal(key('ctrl-c').sequence, '\x03');
  assert.equal(key('ctrl-d').sequence, '\x04');
  assert.equal(key('ctrl-z').sequence, '\x1a');
  assert.equal(key('ctrl-l').sequence, '\x0c');
});

test('defines every standard unmodified function-key sequence in order', () => {
  const functionKeys = MOBILE_TERMINAL_SHORTCUTS.filter((shortcut) => /^f(?:[1-9]|1[0-2])$/.test(shortcut.id));
  assert.deepEqual(functionKeys.map((shortcut) => shortcut.id), [
    'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  ]);
  assert.deepEqual(functionKeys.map((shortcut) => shortcut.type === 'key' && shortcut.sequence), [
    '\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS',
    '\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~',
    '\x1b[20~', '\x1b[21~', '\x1b[23~', '\x1b[24~',
  ]);
});

test('combines character modifiers and consumes eligible input', () => {
  assert.deepEqual(transformTerminalInput('a', modifiers({ shift: true, ctrl: true, alt: true })), {
    data: '\x1b\x01', consumed: true,
  });
  assert.deepEqual(transformTerminalInput('1', modifiers({ shift: true })), { data: '!', consumed: true });
});

test('uses standard modified CSI sequences and Shift+Tab', () => {
  assert.deepEqual(getShortcutSequence(key('up'), modifiers({ shift: true, ctrl: true })), {
    data: '\x1b[1;6A', consumed: true,
  });
  assert.deepEqual(getShortcutSequence(key('page-down'), modifiers({ alt: true })), {
    data: '\x1b[6;3~', consumed: true,
  });
  assert.deepEqual(getShortcutSequence(key('tab'), modifiers({ shift: true })), {
    data: '\x1b[Z', consumed: true,
  });
  assert.deepEqual(getShortcutSequence(key('f1'), modifiers({ shift: true })), {
    data: '\x1b[1;2P', consumed: true,
  });
  assert.deepEqual(getShortcutSequence(key('f4'), modifiers({ ctrl: true, alt: true })), {
    data: '\x1b[1;7S', consumed: true,
  });
  assert.deepEqual(getShortcutSequence(key('f5'), modifiers({ alt: true })), {
    data: '\x1b[15;3~', consumed: true,
  });
  assert.deepEqual(getShortcutSequence(key('f12'), modifiers({ shift: true, ctrl: true, alt: true })), {
    data: '\x1b[24;8~', consumed: true,
  });
});

test('preserves multi-character paste and composition without consuming modifiers', () => {
  assert.deepEqual(transformTerminalInput('hello', modifiers({ ctrl: true })), {
    data: 'hello', consumed: false,
  });
  assert.deepEqual(transformTerminalInput('é', modifiers({ alt: true })), {
    data: 'é', consumed: false,
  });
});

test('does not consume unsupported control combinations', () => {
  assert.deepEqual(transformTerminalInput('1', modifiers({ ctrl: true })), {
    data: '1', consumed: false,
  });
});
