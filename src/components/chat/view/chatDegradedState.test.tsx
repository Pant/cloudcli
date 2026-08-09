import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatStatusBanner } from './chatDegradedState';
import { getChatDataState } from './chatDegradedState.utils';

test('cached rows remain visible with distinct validating, replay, and offline policies', () => {
  assert.equal(getChatDataState({ messageCount: 3, loading: true, sessionStatus: 'loading', transportState: 'connected' }), 'cached-validating');
  assert.equal(getChatDataState({ messageCount: 3, loading: false, sessionStatus: 'idle', transportState: 'replaying' }), 'replay-recovery');
  assert.equal(getChatDataState({ messageCount: 3, loading: false, sessionStatus: 'idle', transportState: 'offline' }), 'stale-offline');
});

test('errors are never classified as empty success and render an alert/retry', () => {
  assert.equal(getChatDataState({ messageCount: 0, loading: false, sessionStatus: 'error', transportState: 'degraded' }), 'backend-unavailable');
  const html = renderToStaticMarkup(<ChatStatusBanner state="backend-unavailable" onRetry={() => undefined} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /Retry history/);
});
