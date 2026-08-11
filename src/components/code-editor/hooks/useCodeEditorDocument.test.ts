import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (relativePath: string) => readFile(new URL(relativePath, import.meta.url), 'utf8');

test('document hook exposes guarded manual reload through the shared read path', async () => {
  const source = await readSource('./useCodeEditorDocument.ts');

  assert.match(source, /loadFileContent = useCallback\(async \(manualReload = false\)/);
  assert.match(source, /if \(reloadingRef\.current \|\| savingRef\.current\) return/);
  assert.match(source, /const response = await api\.readFile\(fileProjectId, filePath\)/);
  assert.match(source, /setSaveSuccess\(false\)/);
  assert.match(source, /setSaveError\(null\)/);
  assert.match(source, /setSaveError\(message\)/);
  assert.match(source, /handleReload/);
  assert.match(source, /reloading,/);
});

test('header wires reload immediately after save with disabled and animated state', async () => {
  const source = await readSource('../view/subcomponents/CodeEditorHeader.tsx');
  const saveButton = source.indexOf('onClick={onSave}');
  const reloadButton = source.indexOf('onClick={onReload}');
  const fullscreenButton = source.indexOf('onClick={onToggleFullscreen}');

  assert.ok(saveButton >= 0 && reloadButton > saveButton && fullscreenButton > reloadButton);
  assert.match(source, /disabled=\{saving \|\| reloading\}/);
  assert.match(source, /reloading \? labels\.reloading : labels\.reload/);
  assert.match(source, /reloading \? 'animate-spin' : ''/);
});

test('document recovery tracks baseline, save success, conflicts, and excludes non-text files', async () => {
  const source = await readSource('./useCodeEditorDocument.ts');
  assert.match(source, /const \[baseline, setBaseline\] = useState\(''\)/);
  assert.match(source, /const isDirty = content !== baseline/);
  assert.match(source, /setBaseline\(content\)/);
  assert.match(source, /editorRecoveryStore\.delete/);
  assert.match(source, /stored\.baseline !== serverContent/);
  assert.match(source, /!previewKind && !isBinaryFile\(fileName\) && !file\.diffInfo/);
  assert.match(source, /restoreRecovery/);
  assert.match(source, /discardRecovery/);
});
