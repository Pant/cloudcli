import assert from 'node:assert/strict';
import test from 'node:test';

import { getAuthTokenRefreshDelay, isAuthTokenExpired, isValidRefreshedToken } from './authToken';

const token = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

test('validates refreshed JWT shape and expiration claims', () => {
  assert.equal(isValidRefreshedToken('not-a-jwt'), false);
  assert.equal(isValidRefreshedToken(token({ iat: 1, exp: 2 })), true);
  assert.equal(isAuthTokenExpired(token({ iat: 1, exp: 2 })), true);
  assert.equal(isAuthTokenExpired(token({ iat: 1 })), false);
});

test('computes a bounded midpoint refresh delay', () => {
  const now = Date.now();
  const refreshDelay = getAuthTokenRefreshDelay(token({ iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 120 }));
  assert.ok(refreshDelay !== null && refreshDelay > 0 && refreshDelay <= 60_000);
});
