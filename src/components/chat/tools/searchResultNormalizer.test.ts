import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSearchToolResult } from './searchResultNormalizer';

test('normalizes Claude-style metadata with an explicit file count', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      content: 'provider text should not replace metadata',
      toolUseResult: {
        numFiles: 2,
        filenames: ['src/one.ts', 'src/two.ts'],
      },
    }),
    { files: ['src/one.ts', 'src/two.ts'], count: 2 },
  );
});

test('finds paths in nested files, matches, and results structures', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      content: {
        results: [
          { files: [{ path: 'src/one.ts' }] },
          { matches: [{ file: 'src/two.ts', line: 12 }, { filename: 'src/three.ts' }] },
        ],
      },
    }),
    { files: ['src/one.ts', 'src/two.ts', 'src/three.ts'], count: 3 },
  );
});

test('parses JSON-encoded structured content', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      content: JSON.stringify({
        totalFiles: 2,
        results: [{ path: 'packages/client.ts' }, { path: 'packages/server.ts' }],
      }),
    }),
    { files: ['packages/client.ts', 'packages/server.ts'], count: 2 },
  );
});

test('parses newline-separated glob paths and ignores summary prose', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      content: 'Found 2 files\nsrc/components/App.tsx\nsrc/components/Button.tsx\nSearch completed',
    }),
    { files: ['src/components/App.tsx', 'src/components/Button.tsx'], count: 2 },
  );
});

test('removes trailing line-count metadata from textual and structured paths', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      content: 'idrc.py (193 lines):\nsrc/report (final).ts\nsrc/schema:current.ts',
      toolUseResult: {
        filenames: [
          '/home/dev/.config/opencode/skills/docs/scripts/docs.py (1457 lines):',
          'src/single.ts (1 line)',
        ],
      },
    }),
    {
      files: [
        '/home/dev/.config/opencode/skills/docs/scripts/docs.py',
        'src/single.ts',
        'idrc.py',
        'src/report (final).ts',
        'src/schema:current.ts',
      ],
      count: 5,
    },
  );
});

test('parses grep path-and-line records and deduplicates matches', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      content: [
        'Found 3 matches in 2 files',
        'src/search.ts:12:needle',
        'src/search.ts:18:needle again',
        'src/index.ts: Line 4:needle',
        'Results truncated after the first matches',
      ].join('\n'),
    }),
    { files: ['src/search.ts', 'src/index.ts'], count: 2 },
  );
});

test('preserves a valid explicit count when visible filenames are truncated', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      toolUseResult: {
        numFiles: 100,
        filenames: ['src/first.ts', 'src/second.ts'],
      },
    }),
    { files: ['src/first.ts', 'src/second.ts'], count: 100 },
  );
});

test('preserves file totals stated in textual truncation summaries', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      content: 'Found 100 files\nsrc/first.ts\nOutput truncated after the first file',
    }),
    { files: ['src/first.ts'], count: 100 },
  );
});

test('uses the larger derived count when an explicit count is stale or too small', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      toolUseResult: {
        numFiles: 1,
        filenames: ['src/one.ts', 'src/two.ts'],
      },
    }),
    { files: ['src/one.ts', 'src/two.ts'], count: 2 },
  );
});

test('returns an empty result for genuine empty search output', () => {
  assert.deepEqual(normalizeSearchToolResult({ content: 'No files found\nFound 0 matches' }), {
    files: [],
    count: 0,
  });
  assert.deepEqual(normalizeSearchToolResult({ toolUseResult: { numFiles: 0, filenames: [] } }), {
    files: [],
    count: 0,
  });
});

test('does not throw for malformed, cyclic, or unexpectedly typed payloads', () => {
  const cyclic: Record<string, unknown> = { files: ['src/safe.ts'] };
  cyclic.self = cyclic;

  assert.doesNotThrow(() => normalizeSearchToolResult({ content: cyclic }));
  assert.deepEqual(normalizeSearchToolResult({ content: cyclic }), {
    files: ['src/safe.ts'],
    count: 1,
  });
  assert.deepEqual(normalizeSearchToolResult({ content: { files: [null, 42, true, { path: 7 }] } }), {
    files: [],
    count: 0,
  });
  assert.deepEqual(normalizeSearchToolResult({ content: '{not valid JSON' }), {
    files: [],
    count: 0,
  });
});
