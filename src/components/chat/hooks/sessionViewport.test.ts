import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceViewportSettle,
  chooseViewportSnapshot,
  getViewportRevisionAction,
  isSelectionCurrent,
  shouldApplyViewportRevision,
  shouldPinViewport,
  shouldCancelViewportSettle,
  transitionViewportOwnership,
  VIEWPORT_SETTLE_MAX_FRAMES,
} from './sessionViewport';

test('saves near-bottom views by bottom distance', () => {
  assert.deepEqual(chooseViewportSnapshot({ scrollTop: 955, scrollHeight: 1200, clientHeight: 220 }, null), {
    mode: 'bottom', bottomDistance: 25,
  });
});

test('A-B-A transitions save the departing viewport and restore only the arriving session', () => {
  const saved = new Map<string, ReturnType<typeof chooseViewportSnapshot>>([
    ['A', { mode: 'anchor', key: 'a2', offset: 9 }],
  ]);
  const toB = transitionViewportOwnership({
    departingIdentityKey: 'A', arrivingIdentityKey: 'B',
    departingViewport: { mode: 'anchor', key: 'a3', offset: 4 }, savedViewports: saved,
  });
  assert.deepEqual(toB.save, { key: 'A', viewport: { mode: 'anchor', key: 'a3', offset: 4 } });
  assert.equal(toB.restore, null);
  saved.set('A', toB.save!.viewport);
  assert.deepEqual(transitionViewportOwnership({
    departingIdentityKey: 'B', arrivingIdentityKey: 'A',
    departingViewport: { mode: 'bottom', bottomDistance: 0 }, savedViewports: saved,
  }).restore, { mode: 'anchor', key: 'a3', offset: 4 });
});

test('real user intent cancels settling but automatic scroll events do not', () => {
  assert.equal(shouldCancelViewportSettle({ userIntent: true, applyingAutomaticScroll: false }), true);
  assert.equal(shouldCancelViewportSettle({ userIntent: true, applyingAutomaticScroll: true }), false);
  assert.equal(shouldCancelViewportSettle({ userIntent: false, applyingAutomaticScroll: false }), false);
});

test('viewport revisions are fenced across rapid exact-identity switches', () => {
  assert.equal(shouldApplyViewportRevision({ expectedIdentityKey: 'selected:a:p', currentIdentityKey: 'selected:b:p', previousRevision: 1, nextRevision: 2, searchActive: false }), false);
  assert.equal(shouldApplyViewportRevision({ expectedIdentityKey: 'selected:b:p', currentIdentityKey: 'selected:b:p', previousRevision: 1, nextRevision: 2, searchActive: false }), true);
  assert.equal(shouldApplyViewportRevision({ expectedIdentityKey: 'selected:b:p', currentIdentityKey: 'selected:b:p', previousRevision: 2, nextRevision: 2, searchActive: false }), false);
});

test('stream revisions use one direct follow only for bottom ownership', () => {
  const base = {
    expectedIdentityKey: 'selected:a:p', currentIdentityKey: 'selected:a:p',
    previousRevision: 1, nextRevision: 2, searchActive: false,
    previousMessages: [{ id: 'stream', kind: 'stream_delta', content: 'a' }],
    nextMessages: [{ id: 'stream', kind: 'stream_delta', content: 'ab' }],
  };
  assert.equal(getViewportRevisionAction({ ...base, saved: { mode: 'bottom', bottomDistance: 0 } }), 'stream-follow');
  assert.equal(getViewportRevisionAction({ ...base, saved: { mode: 'anchor', key: 'older', offset: 4 } }), 'none');
  assert.equal(getViewportRevisionAction({ ...base, saved: { mode: 'bottom', bottomDistance: 0 }, searchActive: true }), 'none');
});

test('session, canonical, final, and other structural revisions retain settlement', () => {
  const common = {
    expectedIdentityKey: 'selected:a:p', currentIdentityKey: 'selected:a:p',
    previousRevision: 1, nextRevision: 2, searchActive: false,
    saved: { mode: 'bottom', bottomDistance: 0 } as const,
  };
  assert.equal(getViewportRevisionAction({ ...common, previousMessages: [], nextMessages: [{ id: 'stream', kind: 'stream_delta', content: 'a' }] }), 'stream-follow');
  assert.equal(getViewportRevisionAction({ ...common, previousMessages: [{ id: 'stream', kind: 'stream_delta', content: 'a' }], nextMessages: [{ id: 'final', kind: 'assistant', content: 'a' }] }), 'structural-settle');
  assert.equal(getViewportRevisionAction({ ...common, previousMessages: [{ id: 'a', kind: 'assistant', content: 'a' }], nextMessages: [{ id: 'a', kind: 'assistant', content: 'a' }, { id: 'b', kind: 'assistant', content: 'b' }] }), 'structural-settle');
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
