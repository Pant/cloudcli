import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { ConsoleMessagesList, PerformanceCaptureControls } from './ConsoleMessagesOverlay';

const sourceUrl = new URL('./ConsoleMessagesOverlay.tsx', import.meta.url);

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

test('performance controls expose accessible guidance and state-dependent actions', () => {
  const idleHtml = renderToStaticMarkup(
    <PerformanceCaptureControls
      isCapturing={false}
      hasReport={false}
      status="Start a capture, reproduce the slowdown, then copy the latest report."
      onStartCapture={() => undefined}
      onCopyReport={() => undefined}
    />,
  );
  assert.match(idleHtml, />Start performance capture</);
  assert.match(idleHtml, /Copy latest performance report/);
  assert.match(idleHtml, /Copy latest performance report<\/button>/);
  assert.match(idleHtml, /disabled=""[^>]*>Copy latest performance report/);
  assert.match(idleHtml, /role="status"/);
  assert.match(idleHtml, /aria-live="polite"/);
  assert.match(idleHtml, /reproduce the slowdown/);

  const capturingHtml = renderToStaticMarkup(
    <PerformanceCaptureControls
      isCapturing
      hasReport
      status="Capture in progress. Reproduce the slowdown during this bounded window."
      onStartCapture={() => undefined}
      onCopyReport={() => undefined}
    />,
  );
  assert.match(capturingHtml, /disabled=""[^>]*>Capturing performance…/);
  assert.doesNotMatch(capturingHtml, /disabled=""[^>]*>Copy latest performance report/);
});

test('overlay wires exact profiler report to clipboard without duplicate logging or close cleanup', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  assert.match(source, /captureClientPerformance\(\)\s*\.then\(report => \{\s*setLatestReport\(report\)/);
  assert.match(source, /navigator\.clipboard\.writeText\(latestReport\)/);
  assert.match(source, /if \(isCapturing\) return/);
  assert.match(source, /if \(open\) setLatestReport\(getLatestClientPerformanceReport\(\)\)/);
  assert.doesNotMatch(source, /console\.info/);
  assert.doesNotMatch(source, /setLatestReport\(null\)/);
});
