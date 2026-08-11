import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editorSidebarSourceUrl = new URL('./EditorSidebar.tsx', import.meta.url);
const mainContentSourceUrl = new URL('../../main-content/view/MainContent.tsx', import.meta.url);

test('normal desktop editor sizing always uses the provided fixed width', async () => {
  const source = await readFile(editorSidebarSourceUrl, 'utf8');

  assert.match(source, /editorExpanded \? undefined : \{ width: `\$\{effectiveWidth\}px`, minWidth: `\$\{MIN_EDITOR_WIDTH\}px` \}/);
  assert.match(source, /editorExpanded \? 'min-w-0 flex-1' : 'flex-shrink-0'/);
  assert.doesNotMatch(source, /fillSpace|hasManualWidth|useFlexLayout/);
});

test('expanded desktop editor retains flex sizing', async () => {
  const source = await readFile(editorSidebarSourceUrl, 'utf8');

  assert.match(source, /className=\{`flex h-full min-w-0 \$\{editorExpanded \? 'flex-1' : ''\}`\}/);
  assert.match(source, /editorExpanded \? 'min-w-0 flex-1' : 'flex-shrink-0'/);
  assert.match(source, /editorExpanded \? undefined/);
});

test('MainContent does not request Files-tab fill-space sizing', async () => {
  const source = await readFile(mainContentSourceUrl, 'utf8');
  const editorSidebar = source.slice(source.indexOf('<EditorSidebar'), source.indexOf('/></ErrorBoundary>', source.indexOf('<EditorSidebar')));

  assert.doesNotMatch(editorSidebar, /fillSpace|hasManualWidth/);
  assert.match(editorSidebar, /editorWidth=\{editorWidth\}/);
});
