import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_CONFIGS } from './toolConfigs';

const searchTools = ['Grep', 'Glob'] as const;

function getSearchDisplay(toolName: (typeof searchTools)[number], result: unknown): { title: string; files: string[] } {
  const config = TOOL_CONFIGS[toolName].result;
  if (!config || typeof config.title !== 'function' || typeof config.getContentProps !== 'function') {
    throw new Error(`${toolName} does not have a callable search result config`);
  }

  return {
    title: config.title(result),
    files: config.getContentProps(result).files,
  };
}

test('ApplyPatch routes supported payload aliases to patch content', () => {
  const config = TOOL_CONFIGS.ApplyPatch.input;
  assert.equal(config.contentType, 'patch');
  assert.equal(config.getContentProps?.({ patchText: 'patchText value' }).patchText, 'patchText value');
  assert.equal(config.getContentProps?.({ patch: 'patch value' }).patchText, 'patch value');
  assert.equal(config.getContentProps?.({ diff: 'diff value' }).patchText, 'diff value');
  assert.equal(config.getContentProps?.({ content: 'content value' }).patchText, 'content value');
  assert.equal(config.getContentProps?.('raw patch').patchText, 'raw patch');
});

test('ApplyPatch ignores non-string payload aliases safely', () => {
  const getContentProps = TOOL_CONFIGS.ApplyPatch.input.getContentProps;
  assert.equal(getContentProps?.({ patchText: { invalid: true }, patch: 'valid patch' }).patchText, 'valid patch');
  assert.equal(getContentProps?.({ patch: 42 }).patchText, '');
  assert.equal(getContentProps?.(null).patchText, '');
});

for (const toolName of searchTools) {
  test(`${toolName} keeps Claude-style metadata results visible`, () => {
    assert.deepEqual(
      getSearchDisplay(toolName, {
        content: 'provider text',
        toolUseResult: {
          numFiles: 2,
          filenames: ['src/one.ts', 'src/two.ts'],
        },
      }),
      {
        title: 'Found 2 files',
        files: ['src/one.ts', 'src/two.ts'],
      },
    );
  });

  test(`${toolName} displays content-only provider results`, () => {
    assert.deepEqual(
      getSearchDisplay(toolName, {
        content: 'Found 2 files\nsrc/content-one.ts\nsrc/content-two.ts',
      }),
      {
        title: 'Found 2 files',
        files: ['src/content-one.ts', 'src/content-two.ts'],
      },
    );
  });

  test(`${toolName} uses grammatical zero-result wording`, () => {
    assert.deepEqual(
      getSearchDisplay(toolName, { content: 'No files found\nFound 0 matches' }),
      {
        title: 'Found 0 files',
        files: [],
      },
    );
  });
}
