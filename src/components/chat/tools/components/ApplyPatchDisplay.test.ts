import assert from 'node:assert/strict';
import test from 'node:test';

import { parseApplyPatch } from './applyPatchModel';

test('parses ordered multi-file add, update, delete, and empty operations', () => {
  const model = parseApplyPatch(`*** Begin Patch
*** Add File: new.txt
+first
+second
*** Update File: old.txt
@@ -10,2 +10,2 @@
 same
-before
+after
*** Delete File: gone.txt
-last
*** Add File: empty.txt
*** End Patch`);

  assert.equal(model.kind, 'patch');
  if (model.kind !== 'patch') return;
  assert.deepEqual(model.files.map(({ operation, path }) => ({ operation, path })), [
    { operation: 'add', path: 'new.txt' },
    { operation: 'update', path: 'old.txt' },
    { operation: 'delete', path: 'gone.txt' },
    { operation: 'add', path: 'empty.txt' },
  ]);
  assert.deepEqual(model.files[1].lines, [
    { kind: 'context', content: 'same', oldLine: 10, newLine: 10 },
    { kind: 'remove', content: 'before', oldLine: 11, newLine: null },
    { kind: 'add', content: 'after', oldLine: null, newLine: 11 },
  ]);
  assert.deepEqual(model.files[3].lines, []);
});

test('models stripped hunk headers with sequential local line numbers', () => {
  const model = parseApplyPatch(`*** Begin Patch
*** Update File: file.ts
@@
 alpha
-beta
+gamma
 omega
*** End Patch`);

  assert.equal(model.kind, 'patch');
  if (model.kind !== 'patch') return;
  assert.deepEqual(model.files[0].lines.map(({ oldLine, newLine }) => [oldLine, newLine]), [
    [1, 1], [2, null], [null, 2], [3, 3],
  ]);
});

test('continues numbering across repeated bare and context-labeled stripped hunks', () => {
  const model = parseApplyPatch(`*** Begin Patch
*** Update File: file.ts
@@
 first
-second
+replacement
@@ functionName
 third
@@ className.method
-fourth
+final
*** End Patch`);

  assert.equal(model.kind, 'patch');
  if (model.kind !== 'patch') return;
  assert.deepEqual(model.files[0].lines.map(({ oldLine, newLine }) => [oldLine, newLine]), [
    [1, 1], [2, null], [null, 2], [3, 3], [4, null], [null, 4],
  ]);
});

test('starts stripped numbering at one for each new file while numeric hunks retain declared starts', () => {
  const model = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
 first
@@ -10,2 +20,3 @@ label
 second
*** Update File: second.ts
@@ context
 second-file
*** End Patch`);

  assert.equal(model.kind, 'patch');
  if (model.kind !== 'patch') return;
  assert.deepEqual(model.files[0].lines.map(({ oldLine, newLine }) => [oldLine, newLine]), [
    [1, 1], [10, 20],
  ]);
  assert.deepEqual(model.files[1].lines.map(({ oldLine, newLine }) => [oldLine, newLine]), [
    [1, 1],
  ]);
});

test('preserves move destination and changed content', () => {
  const model = parseApplyPatch(`*** Begin Patch
*** Update File: before.ts
*** Move to: after.ts
@@ -4 +4 @@
-old
+new
*** End Patch`);

  assert.equal(model.kind, 'patch');
  if (model.kind !== 'patch') return;
  assert.equal(model.files[0].operation, 'move');
  assert.equal(model.files[0].moveTo, 'after.ts');
  assert.deepEqual(model.files[0].lines.map((line) => line.content), ['old', 'new']);
});

test('keeps long content intact for wrapping by the renderer', () => {
  const longLine = 'segment/'.repeat(100);
  const model = parseApplyPatch(`*** Begin Patch\n*** Add File: long.txt\n+${longLine}\n*** End Patch`);

  assert.equal(model.kind, 'patch');
  if (model.kind !== 'patch') return;
  assert.equal(model.files[0].lines[0].content, longLine);
});

test('returns the original malformed input as visible fallback without throwing', () => {
  const malformed = '*** Begin Patch\nnot a file section\n*** End Patch';
  assert.deepEqual(parseApplyPatch(malformed), { kind: 'fallback', content: malformed });
  assert.deepEqual(parseApplyPatch('plain text'), { kind: 'fallback', content: 'plain text' });

  const malformedHunk = '*** Begin Patch\n*** Update File: file.ts\n@@ -bad +1 @@\n+line\n*** End Patch';
  assert.deepEqual(parseApplyPatch(malformedHunk), { kind: 'fallback', content: malformedHunk });
});
