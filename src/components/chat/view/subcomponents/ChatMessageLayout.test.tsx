import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('dynamic chat rows use actual normal-flow geometry', async () => {
  const css = await readFile(new URL('../../../../index.css', import.meta.url), 'utf8');
  const chatMessageRule = css.match(/\.chat-message\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.doesNotMatch(chatMessageRule, /content-visibility\s*:/);
  assert.doesNotMatch(chatMessageRule, /contain-intrinsic-size\s*:/);
  assert.doesNotMatch(chatMessageRule, /contain\s*:\s*[^;]*(?:layout|paint)/);
  assert.doesNotMatch(css, /\.chat-message[^{}]*\{[^}]*contain-intrinsic-size\s*:/s);
});

test('top-level messages own exactly one stable viewport anchor', async () => {
  const source = await readFile(new URL('./MessageComponent.tsx', import.meta.url), 'utf8');
  assert.equal(source.match(/data-message-key=/g)?.length, 1);
  assert.match(source, /data-message-key=\{ownsMessageAnchor \? messageKey : undefined\}/);
  assert.match(source, /ownsMessageAnchor = true/);
});

test('messages expanded inside a tool group do not claim top-level anchors', async () => {
  const source = await readFile(new URL('./ToolGroupContainer.tsx', import.meta.url), 'utf8');
  assert.equal(source.match(/data-message-key=/g)?.length, 1);
  assert.match(source, /data-message-key=\{`tool-group-\$\{getMessageKey\(group\.messages\[0\]\)\}`\}/);
  assert.match(source, /ownsMessageAnchor=\{false\}/);
});

test('OpenCode response metadata uses a responsive centered and right-aligned footer', async () => {
  const source = await readFile(new URL('./MessageComponent.tsx', import.meta.url), 'utf8');

  assert.match(source, /provider === 'opencode' && message\.type === 'assistant'/);
  assert.match(source, /grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
  assert.match(source, /whitespace-nowrap text-center/);
  assert.match(source, /justify-self-end whitespace-nowrap text-right/);
  assert.match(source, /tabular-nums/);
  assert.match(source, />Input<\/span>/);
  assert.match(source, />Output<\/span>/);
});

test('tool groups own all represented OpenCode metadata without child duplication', async () => {
  const source = await readFile(new URL('./ToolGroupContainer.tsx', import.meta.url), 'utf8');

  assert.match(source, /provider === 'opencode'/);
  assert.match(source, /group\.messages\.flatMap/);
  assert.match(source, /responseMetadata\.map/);
  assert.match(source, /ownsResponseMetadataFooter=\{false\}/);
});
