import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LARGE_TRANSCRIPT_THRESHOLD,
  accessibleWindowPositions,
  calculateMeasuredWindow,
  compensateMeasuredGrowth,
  keyboardWindowTarget,
  recordMeasuredHeight,
  viewportMetricsChanged,
} from './transcriptWindow';

test('row measurements only record genuine positive height changes', () => {
  const heights = new Map<number, number>();
  assert.deepEqual(recordMeasuredHeight(heights, 4, 120), { previousHeight: undefined, changed: true });
  assert.deepEqual(recordMeasuredHeight(heights, 4, 120), { previousHeight: 120, changed: false });
  assert.deepEqual(recordMeasuredHeight(heights, 4, 0), { previousHeight: 120, changed: false });
  assert.deepEqual(recordMeasuredHeight(heights, 4, 240), { previousHeight: 120, changed: true });
  assert.equal(heights.get(4), 240);
});

test('unchanged transcript viewport metrics do not require a window revision', () => {
  const metrics = { scrollTop: 1200, width: 900, height: 640 };
  assert.equal(viewportMetricsChanged(metrics, { ...metrics }), false);
});

test('initial, scroll, and viewport size changes require a window revision', () => {
  const metrics = { scrollTop: 1200, width: 900, height: 640 };
  assert.equal(viewportMetricsChanged(null, metrics), true);
  assert.equal(viewportMetricsChanged(metrics, { ...metrics, scrollTop: 1320 }), true);
  assert.equal(viewportMetricsChanged(metrics, { ...metrics, width: 880 }), true);
  assert.equal(viewportMetricsChanged(metrics, { ...metrics, height: 720 }), true);
});

test('normal 100-row transcripts retain the complete rendering path', () => {
  assert.deepEqual(calculateMeasuredWindow(LARGE_TRANSCRIPT_THRESHOLD, 6000, 600, new Map()), {
    start: 0, end: 100, before: 0, after: 0,
  });
});

test('large histories keep mounted rows bounded at top, middle, and bottom', () => {
  for (const scrollTop of [0, 60_000, 119_400]) {
    const window = calculateMeasuredWindow(1000, scrollTop, 600, new Map());
    assert.ok(window.end - window.start <= 20, `mounted ${window.end - window.start} rows`);
    assert.equal(window.before + window.after + (window.end - window.start) * 120, 120_000);
  }
});

test('a search target outside the viewport gets its own centered bounded window', () => {
  const window = calculateMeasuredWindow(1000, 0, 600, new Map(), 750);
  assert.ok(window.start <= 750 && window.end > 750);
  assert.ok(window.end - window.start <= 20);
  assert.ok(window.start > 700, 'does not mount every row between the old viewport and target');
});

test('expansion and delayed image or code growth above the viewport preserve the keyed anchor', () => {
  for (const nextHeight of [232, 480]) {
    assert.equal(compensateMeasuredGrowth({
      rowIndex: 20, windowStart: 40, previousHeight: 120, nextHeight,
      scrollTop: 5000, followingBottom: false,
    }), 5000 + nextHeight - 120);
  }
  assert.equal(compensateMeasuredGrowth({
    rowIndex: 45, windowStart: 40, previousHeight: 120, nextHeight: 480,
    scrollTop: 5000, followingBottom: false,
  }), 5000);
});

test('delayed row growth follows the bottom but keeps scrolled-up rows stable', () => {
  assert.equal(compensateMeasuredGrowth({
    rowIndex: 98, windowStart: 90, previousHeight: 120, nextHeight: 300,
    scrollTop: 11_400, followingBottom: true,
  }), 11_580);
  assert.equal(compensateMeasuredGrowth({
    rowIndex: 98, windowStart: 90, previousHeight: 120, nextHeight: 300,
    scrollTop: 9000, followingBottom: false,
  }), 9000);
});

test('keyboard navigation reveals adjacent and boundary rows without escaping transcript bounds', () => {
  assert.equal(keyboardWindowTarget(500, 'ArrowUp', 1000), 499);
  assert.equal(keyboardWindowTarget(500, 'ArrowDown', 1000), 501);
  assert.equal(keyboardWindowTarget(500, 'Home', 1000), 0);
  assert.equal(keyboardWindowTarget(500, 'End', 1000), 999);
  assert.equal(keyboardWindowTarget(0, 'ArrowUp', 1000), 0);
  assert.equal(keyboardWindowTarget(999, 'ArrowDown', 1000), 999);
});

test('accessible positions preserve chronological reading order across a window', () => {
  const window = calculateMeasuredWindow(1000, 60_000, 600, new Map());
  const positions = accessibleWindowPositions(window, 1000);
  assert.deepEqual(positions.map(({ index }) => index), [...positions.map(({ index }) => index)].sort((a, b) => a - b));
  assert.equal(positions[0].position, window.start + 1);
  assert.equal(positions.at(-1)?.position, window.end);
  assert.ok(positions.every(({ size }) => size === 1000));
});
