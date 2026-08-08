import assert from 'node:assert/strict';
import test from 'node:test';

import { matchRoutes } from 'react-router-dom';

import { appRoutes } from './appRoutes';

test('root and session URLs share one app-shell route and expose an optional session id', () => {
  const rootMatches = matchRoutes(appRoutes, '/');
  const sessionMatches = matchRoutes(appRoutes, '/session/session-123');

  assert.ok(rootMatches);
  assert.ok(sessionMatches);
  assert.equal(rootMatches[0].route, appRoutes[0]);
  assert.equal(sessionMatches[0].route, appRoutes[0]);
  assert.ok(rootMatches.at(-1)?.route.element);
  assert.ok(sessionMatches.at(-1)?.route.element);
  assert.equal(rootMatches[0].params.sessionId, undefined);
  assert.equal(sessionMatches[0].params.sessionId, 'session-123');
});

test('the shared route matches URLs after a deployment basename is removed', () => {
  const matches = matchRoutes(appRoutes, '/ai/session/session-456', '/ai');

  assert.ok(matches);
  assert.equal(matches[0].route, appRoutes[0]);
  assert.ok(matches.at(-1)?.route.element);
  assert.equal(matches[0].params.sessionId, 'session-456');
});
