export type MobileTerminalModifier = 'shift' | 'ctrl' | 'alt';

export type MobileTerminalModifiers = Record<MobileTerminalModifier, boolean>;

export const EMPTY_MOBILE_TERMINAL_MODIFIERS: MobileTerminalModifiers = {
  shift: false,
  ctrl: false,
  alt: false,
};

type PlainShortcut = {
  type: 'key';
  id: string;
  label: string;
  sequence: string;
  ariaLabel?: string;
  csiFinal?: 'A' | 'B' | 'C' | 'D' | 'H' | 'F' | 'P' | 'Q' | 'R' | 'S';
  csiTilde?: 2 | 3 | 5 | 6 | 15 | 17 | 18 | 19 | 20 | 21 | 23 | 24;
};

export type MobileTerminalShortcut =
  | PlainShortcut
  | { type: 'modifier'; id: MobileTerminalModifier; label: string; ariaLabel: string };

export const MOBILE_TERMINAL_SHORTCUTS: MobileTerminalShortcut[] = [
  { type: 'key', id: 'esc', label: 'Esc', sequence: '\x1b' },
  { type: 'key', id: 'tab', label: 'Tab', sequence: '\t' },
  { type: 'modifier', id: 'shift', label: 'Shift', ariaLabel: 'Shift modifier' },
  { type: 'modifier', id: 'ctrl', label: 'Ctrl', ariaLabel: 'Control modifier' },
  { type: 'modifier', id: 'alt', label: 'Alt', ariaLabel: 'Alt modifier' },
  { type: 'key', id: 'up', label: '↑', ariaLabel: 'Up arrow', sequence: '\x1b[A', csiFinal: 'A' },
  { type: 'key', id: 'down', label: '↓', ariaLabel: 'Down arrow', sequence: '\x1b[B', csiFinal: 'B' },
  { type: 'key', id: 'left', label: '←', ariaLabel: 'Left arrow', sequence: '\x1b[D', csiFinal: 'D' },
  { type: 'key', id: 'right', label: '→', ariaLabel: 'Right arrow', sequence: '\x1b[C', csiFinal: 'C' },
  { type: 'key', id: 'home', label: 'Home', sequence: '\x1b[H', csiFinal: 'H' },
  { type: 'key', id: 'end', label: 'End', sequence: '\x1b[F', csiFinal: 'F' },
  { type: 'key', id: 'page-up', label: 'PgUp', sequence: '\x1b[5~', csiTilde: 5 },
  { type: 'key', id: 'page-down', label: 'PgDn', sequence: '\x1b[6~', csiTilde: 6 },
  { type: 'key', id: 'insert', label: 'Ins', sequence: '\x1b[2~', csiTilde: 2 },
  { type: 'key', id: 'delete', label: 'Del', sequence: '\x1b[3~', csiTilde: 3 },
  { type: 'key', id: 'enter', label: 'Enter', sequence: '\r' },
  { type: 'key', id: 'backspace', label: '⌫', ariaLabel: 'Backspace', sequence: '\x7f' },
  { type: 'key', id: 'f1', label: 'F1', sequence: '\x1bOP', csiFinal: 'P' },
  { type: 'key', id: 'f2', label: 'F2', sequence: '\x1bOQ', csiFinal: 'Q' },
  { type: 'key', id: 'f3', label: 'F3', sequence: '\x1bOR', csiFinal: 'R' },
  { type: 'key', id: 'f4', label: 'F4', sequence: '\x1bOS', csiFinal: 'S' },
  { type: 'key', id: 'f5', label: 'F5', sequence: '\x1b[15~', csiTilde: 15 },
  { type: 'key', id: 'f6', label: 'F6', sequence: '\x1b[17~', csiTilde: 17 },
  { type: 'key', id: 'f7', label: 'F7', sequence: '\x1b[18~', csiTilde: 18 },
  { type: 'key', id: 'f8', label: 'F8', sequence: '\x1b[19~', csiTilde: 19 },
  { type: 'key', id: 'f9', label: 'F9', sequence: '\x1b[20~', csiTilde: 20 },
  { type: 'key', id: 'f10', label: 'F10', sequence: '\x1b[21~', csiTilde: 21 },
  { type: 'key', id: 'f11', label: 'F11', sequence: '\x1b[23~', csiTilde: 23 },
  { type: 'key', id: 'f12', label: 'F12', sequence: '\x1b[24~', csiTilde: 24 },
  { type: 'key', id: 'ctrl-c', label: 'Ctrl+C', sequence: '\x03' },
  { type: 'key', id: 'ctrl-d', label: 'Ctrl+D', sequence: '\x04' },
  { type: 'key', id: 'ctrl-z', label: 'Ctrl+Z', sequence: '\x1a' },
  { type: 'key', id: 'ctrl-l', label: 'Ctrl+L', sequence: '\x0c' },
];

const SHIFTED_ASCII: Record<string, string> = {
  '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&',
  '8': '*', '9': '(', '0': ')', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
  ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
};

export function hasMobileTerminalModifiers(modifiers: MobileTerminalModifiers): boolean {
  return modifiers.shift || modifiers.ctrl || modifiers.alt;
}

function modifierParameter(modifiers: MobileTerminalModifiers): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

export function transformTerminalInput(
  data: string,
  modifiers: MobileTerminalModifiers,
): { data: string; consumed: boolean } {
  if (!hasMobileTerminalModifiers(modifiers) || Array.from(data).length !== 1) {
    return { data, consumed: false };
  }

  let transformed = data;
  if (modifiers.shift) {
    transformed = /^[a-z]$/.test(transformed)
      ? transformed.toUpperCase()
      : (SHIFTED_ASCII[transformed] ?? transformed);
  }
  if (modifiers.ctrl) {
    const upper = transformed.toUpperCase();
    if (/^[A-Z]$/.test(upper)) transformed = String.fromCharCode(upper.charCodeAt(0) - 64);
    else if (upper === '@' || upper === ' ') transformed = '\x00';
    else if (upper === '[') transformed = '\x1b';
    else if (upper === '\\') transformed = '\x1c';
    else if (upper === ']') transformed = '\x1d';
    else if (upper === '^') transformed = '\x1e';
    else if (upper === '_') transformed = '\x1f';
    else return { data, consumed: false };
  }
  if (modifiers.alt) transformed = `\x1b${transformed}`;
  return { data: transformed, consumed: true };
}

export function getShortcutSequence(
  shortcut: PlainShortcut,
  modifiers: MobileTerminalModifiers,
): { data: string; consumed: boolean } {
  if (!hasMobileTerminalModifiers(modifiers)) return { data: shortcut.sequence, consumed: false };
  const parameter = modifierParameter(modifiers);
  if (shortcut.csiFinal) return { data: `\x1b[1;${parameter}${shortcut.csiFinal}`, consumed: true };
  if (shortcut.csiTilde) return { data: `\x1b[${shortcut.csiTilde};${parameter}~`, consumed: true };
  if (shortcut.id === 'tab' && modifiers.shift && !modifiers.ctrl && !modifiers.alt) {
    return { data: '\x1b[Z', consumed: true };
  }
  return transformTerminalInput(shortcut.sequence, modifiers);
}
