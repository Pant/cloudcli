import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('font delivery is local, licensed, bounded, and launch metadata is theme-aware', async () => {
  const [html, css, markdown, math, theme] = await Promise.all([
    readFile(path.join(root, 'index.html'), 'utf8'),
    readFile(path.join(root, 'src/index.css'), 'utf8'),
    readFile(path.join(root, 'src/components/chat/view/subcomponents/Markdown.tsx'), 'utf8'),
    readFile(path.join(root, 'src/components/chat/view/subcomponents/MarkdownMath.tsx'), 'utf8'),
    readFile(path.join(root, 'src/contexts/ThemeContext.tsx'), 'utf8'),
  ]);
  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/);
  assert.match(html, /localStorage\.getItem\('theme'\)/);
  assert.match(html, /theme-color[^>]+prefers-color-scheme: dark/);
  assert.match(theme, /style\.colorScheme/);
  assert.match(css, /encode-sans-latin\.woff2/);
  assert.match(css, /encode-sans-latin-ext\.woff2/);
  assert.match(css, /font-display: optional/);
  assert.doesNotMatch(css, /Merriweather/);
  assert.match(markdown, /hasMarkdownMath/);
  assert.doesNotMatch(markdown, /katex\/dist\/katex\.min\.css/);
  assert.match(math, /katex\/dist\/katex\.min\.css/);
  for (const file of ['encode-sans-latin.woff2', 'encode-sans-latin-ext.woff2']) {
    const info = await stat(path.join(root, 'public/fonts', file));
    assert.ok(info.size > 1_000 && info.size < 100_000, `${file} must be a bounded WOFF2`);
  }
  assert.match(await readFile(path.join(root, 'public/fonts/OFL-Encode-Sans.txt'), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
});

test('built output contains no third-party launch requests and retains local fonts', async () => {
  const html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
  const files = await Promise.all(['encode-sans-latin.woff2', 'encode-sans-latin-ext.woff2'].map((file) => stat(path.join(root, 'dist/fonts', file))));
  assert.doesNotMatch(html, /https?:\/\//);
  assert.ok(files.every((file) => file.size > 1_000));
});
