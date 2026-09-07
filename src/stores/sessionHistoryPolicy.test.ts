import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSessionMessagesUrl,
  getVisibleHistoryWindow,
  normalizeCompleteHistoryState,
  reconcileLocalHistoryVisibility,
  revealAllLocalHistory,
  revealLocalHistoryWindow,
} from './sessionHistoryPolicy';

test('ordinary history requests omit numeric pagination parameters', () => {
  assert.equal(
    buildSessionMessagesUrl('session/with spaces'),
    '/api/providers/sessions/session%2Fwith%20spaces/messages',
  );
  assert.equal(
    buildSessionMessagesUrl('session-1', { limit: null, offset: 0 }),
    '/api/providers/sessions/session-1/messages',
  );
});

test('complete history state never reports remaining server pages', () => {
  const state = normalizeCompleteHistoryState(
    [{ id: 'one' } as never, { id: 'two' } as never],
    2,
  );

  assert.deepEqual(state, { total: 2, hasMore: false, offset: 2 });
  assert.deepEqual(
    normalizeCompleteHistoryState([{ id: 'one' } as never], undefined),
    { total: 1, hasMore: false, offset: 1 },
  );
});

test('local history reveal grows the newest-message window without fetching', () => {
  assert.deepEqual(revealLocalHistoryWindow(100, 250), {
    visibleCount: 200,
    allMessagesLoaded: false,
  });
  assert.deepEqual(revealLocalHistoryWindow(200, 250), {
    visibleCount: 250,
    allMessagesLoaded: true,
  });
  assert.deepEqual(revealLocalHistoryWindow(100, 250, 500), {
    visibleCount: 250,
    allMessagesLoaded: true,
  });
});

test('reveal all exposes an entire 132-message local transcript at once', () => {
  const messages = Array.from({ length: 132 }, (_, index) => index + 1);
  assert.deepEqual(getVisibleHistoryWindow(messages, 100), messages.slice(32));

  const reveal = revealAllLocalHistory(messages.length);
  assert.deepEqual(reveal, { visibleCount: 132, allMessagesLoaded: true });
  assert.deepEqual(getVisibleHistoryWindow(messages, reveal.visibleCount), messages);
});

test('same-session synchronization preserves reveal-all visibility and transcript growth', () => {
  const revealed = reconcileLocalHistoryVisibility({
    identityKey: 'project-1:session-1',
    revealAllIdentityKey: 'project-1:session-1',
    totalMessages: 132,
    hasCompleteHistory: true,
  });
  assert.deepEqual(revealed, { visibleCount: Infinity, allMessagesLoaded: true });
  assert.equal(getVisibleHistoryWindow(Array.from({ length: 133 }), revealed.visibleCount).length, 133);

  assert.deepEqual(reconcileLocalHistoryVisibility({
    identityKey: 'project-1:session-2',
    revealAllIdentityKey: 'project-1:session-1',
    totalMessages: 132,
    hasCompleteHistory: true,
  }), { visibleCount: 100, allMessagesLoaded: false });
});

test('visible history window keeps the newest rows and can reveal all locally', () => {
  const messages = [1, 2, 3, 4, 5];
  assert.deepEqual(getVisibleHistoryWindow(messages, 2), [4, 5]);
  assert.deepEqual(getVisibleHistoryWindow(messages, Infinity), messages);
});
