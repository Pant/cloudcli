import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFileReference } from './useFileOpenResolver';

const files = [
  { name: 'idrc.py', path: 'src/idrc.py' },
  { name: 'report (final).ts', path: 'src/report (final).ts' },
  { name: 'schema:current.ts', path: 'src/schema:current.ts' },
];

test('cleans decorated references before matching and fallback forwarding', () => {
  assert.equal(resolveFileReference(files, 'idrc.py (193 lines):'), 'src/idrc.py');
  assert.equal(
    resolveFileReference([], '/home/dev/.config/opencode/skills/docs/scripts/docs.py (1457 lines):'),
    '/home/dev/.config/opencode/skills/docs/scripts/docs.py',
  );
});

test('preserves matching behavior and legitimate parentheses and colons', () => {
  assert.equal(resolveFileReference(files, './src/idrc.py'), 'src/idrc.py');
  assert.equal(resolveFileReference(files, 'report (final).ts'), 'src/report (final).ts');
  assert.equal(resolveFileReference(files, 'schema:current.ts'), 'src/schema:current.ts');
  assert.equal(resolveFileReference([], 'src/idrc.py:12:4'), 'src/idrc.py:12:4');
});
