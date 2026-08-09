import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { ConsoleMessagesList } from './ConsoleMessagesOverlay';

test('console message list renders an accessible empty state', () => {
  const html = renderToStaticMarkup(<ConsoleMessagesList entries={[]} />);
  assert.match(html, /No console messages captured yet/);
});

test('console message list identifies severity and preserves multiline content', () => {
  const html = renderToStaticMarkup(<ConsoleMessagesList entries={[{
    id: 1,
    level: 'error',
    timestamp: '2026-01-01T12:34:56.000Z',
    text: 'first line\nsecond line',
  }]} />);
  assert.match(html, /Captured console messages/);
  assert.match(html, />error</);
  assert.match(html, /first line\nsecond line/);
  assert.match(html, /dateTime="2026-01-01T12:34:56.000Z"/);
});
