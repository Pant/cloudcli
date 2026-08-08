import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSessionMessagesUrl,
  getVisibleHistoryWindow,
  normalizeCompleteHistoryState,
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

test('visible history window keeps the newest rows and can reveal all locally', () => {
  const messages = [1, 2, 3, 4, 5];
  assert.deepEqual(getVisibleHistoryWindow(messages, 2), [4, 5]);
  assert.deepEqual(getVisibleHistoryWindow(messages, Infinity), messages);
});
