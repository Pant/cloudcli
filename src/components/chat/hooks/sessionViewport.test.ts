import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceViewportSettle,
  chooseViewportSnapshot,
  isSelectionCurrent,
  shouldApplyViewportRevision,
  shouldPinViewport,
  VIEWPORT_SETTLE_MAX_FRAMES,
} from './sessionViewport';

test('saves near-bottom views by bottom distance', () => {
  assert.deepEqual(chooseViewportSnapshot({ scrollTop: 955, scrollHeight: 1200, clientHeight: 220 }, null), {
    mode: 'bottom', bottomDistance: 25,
  });
});

test('viewport revisions are fenced across rapid exact-identity switches', () => {
  assert.equal(shouldApplyViewportRevision({ expectedIdentityKey: 'selected:a:p', currentIdentityKey: 'selected:b:p', previousRevision: 1, nextRevision: 2, searchActive: false }), false);
  assert.equal(shouldApplyViewportRevision({ expectedIdentityKey: 'selected:b:p', currentIdentityKey: 'selected:b:p', previousRevision: 1, nextRevision: 2, searchActive: false }), true);
  assert.equal(shouldApplyViewportRevision({ expectedIdentityKey: 'selected:b:p', currentIdentityKey: 'selected:b:p', previousRevision: 2, nextRevision: 2, searchActive: false }), false);
});

test('settling stops after stable measurements or the frame bound', () => {
  let state = { frame: 0, stableFrames: 0, lastMeasurement: null as number | null };
  let result = advanceViewportSettle(state, 100);
  result = advanceViewportSettle(result.state, 100);
  result = advanceViewportSettle(result.state, 100);
  result = advanceViewportSettle(result.state, 100);
  assert.equal(result.done, true);

  state = { frame: VIEWPORT_SETTLE_MAX_FRAMES - 1, stableFrames: 0, lastMeasurement: 1 };
  assert.equal(advanceViewportSettle(state, 2).done, true);
});

test('async selection callbacks require the exact non-null key', () => {
  assert.equal(isSelectionCurrent('a:p', 'a:p'), true);
  assert.equal(isSelectionCurrent('a:p', 'b:p'), false);
  assert.equal(isSelectionCurrent(null, null), false);
});

test('saves scrolled-up views by keyed anchor', () => {
  assert.deepEqual(chooseViewportSnapshot(
    { scrollTop: 300, scrollHeight: 1200, clientHeight: 220 },
    { key: 'message-a', offset: 12 },
  ), { mode: 'anchor', key: 'message-a', offset: 12 });
});

test('first opens and bottom snapshots pin, search overrides', () => {
  assert.equal(shouldPinViewport({ saved: null, searchActive: false, firstOpen: true }), true);
  assert.equal(shouldPinViewport({ saved: { mode: 'bottom', bottomDistance: 2 }, searchActive: false, firstOpen: false }), true);
  assert.equal(shouldPinViewport({ saved: { mode: 'anchor', key: 'a', offset: 0 }, searchActive: false, firstOpen: false }), false);
  assert.equal(shouldPinViewport({ saved: null, searchActive: true, firstOpen: true }), false);
});
