import assert from 'node:assert/strict';
import test from 'node:test';

import { matchRoutes } from 'react-router-dom';

import { appRoutes } from './appRoutes';
import { inferRouterBasename, type RouterBasenameHint } from './routerBasename';

const sessionId = '123e4567-e89b-12d3-a456-426614174000';

function infer(pathname: string, hints: RouterBasenameHint[], explicitBasename = '') {
  return inferRouterBasename({
    explicitBasename,
    baseUrl: `https://cloudcli.test${pathname}`,
    origin: 'https://cloudcli.test',
    hints,
  });
}

test('root session deep links prefer root deployment metadata over a route-relative icon', () => {
  const pathname = `/session/${sessionId}`;
  const basename = infer(pathname, [
    { kind: 'manifest', value: '/manifest.json' },
    { kind: 'script', value: '/assets/index-abc.js' },
    { kind: 'icon', value: './icons/apple-touch-icon-180x180.png' },
  ]);

  assert.equal(basename, '');
  assert.equal(matchRoutes(appRoutes, pathname, basename)?.at(-1)?.params.sessionId, sessionId);
});

test('subpath session deep links infer the real deployment prefix and match the canonical route', () => {
  const pathname = `/ai/session/${sessionId}`;
  const basename = infer(pathname, [
    { kind: 'manifest', value: '/ai/manifest.json' },
    { kind: 'script', value: '/ai/assets/index-abc.js' },
    { kind: 'icon', value: './icons/apple-touch-icon-180x180.png' },
  ]);

  assert.equal(basename, '/ai');
  assert.equal(matchRoutes(appRoutes, pathname, basename)?.at(-1)?.params.sessionId, sessionId);
});

test('explicit runtime basename remains authoritative and normalized', () => {
  assert.equal(infer(`/session/${sessionId}`, [{ kind: 'manifest', value: '/manifest.json' }], '/configured/'), '/configured');
});
