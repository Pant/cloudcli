import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_SAVED_CHAT_VIEWPORTS, saveBoundedViewport } from './useChatSessionState';

test('saved viewport LRU is bounded and preserves the active viewport', () => {
  const viewports = new Map();
  for (let index = 0; index < MAX_SAVED_CHAT_VIEWPORTS + 4; index++) {
    saveBoundedViewport(viewports, `session-${index}`, { mode: 'bottom', bottomDistance: index }, 'session-0');
  }
  assert.equal(viewports.size, MAX_SAVED_CHAT_VIEWPORTS);
  assert.ok(viewports.has('session-0'));
  assert.equal(viewports.has('session-1'), false);
});
