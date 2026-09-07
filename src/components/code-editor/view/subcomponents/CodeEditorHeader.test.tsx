import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const headerSourceUrl = new URL('./CodeEditorHeader.tsx', import.meta.url);
const editorSourceUrl = new URL('../CodeEditor.tsx', import.meta.url);

test('line-wrap action exposes enabled and disabled accessible states', async () => {
  const source = await readFile(headerSourceUrl, 'utf8');

  assert.match(source, /onClick=\{onToggleWordWrap\}/);
  assert.match(source, /aria-pressed=\{wordWrap\}/);
  assert.match(source, /aria-label=\{wordWrap \? labels\.disableWordWrap : labels\.enableWordWrap\}/);
  assert.match(source, /title=\{wordWrap \? labels\.disableWordWrap : labels\.enableWordWrap\}/);
  assert.match(source, /wordWrap\s*\? 'bg-blue-50 text-blue-600 dark:bg-blue-900\/30 dark:text-blue-400'/);
  assert.match(source, /<WrapText className="h-4 w-4" \/>/);
});

test('editor wires the persisted wrap setting to the header and CodeMirror', async () => {
  const source = await readFile(editorSourceUrl, 'utf8');

  assert.match(source, /wordWrap=\{wordWrap\}/);
  assert.match(source, /onToggleWordWrap=\{\(\) => setWordWrap\(\(previous\) => !previous\)\}/);
  assert.match(source, /if \(wordWrap\) \{\s*allExtensions\.push\(EditorView\.lineWrapping\);/);
});
