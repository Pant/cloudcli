import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderMcpServer } from '../types';

import { createMcpTogglePayload } from './useMcpServers';

test('createMcpTogglePayload retains the complete server definition and changes enabled', () => {
  const server: ProviderMcpServer = {
    provider: 'opencode',
    name: 'cloudcli-browser',
    scope: 'user',
    transport: 'stdio',
    command: 'node',
    args: ['browser.js'],
    env: { MODE: 'managed' },
    cwd: '/tmp/browser',
    enabled: true,
  };

  assert.deepEqual(createMcpTogglePayload(server, false), {
    name: 'cloudcli-browser',
    scope: 'user',
    transport: 'stdio',
    workspacePath: undefined,
    command: 'node',
    args: ['browser.js'],
    env: { MODE: 'managed' },
    cwd: '/tmp/browser',
    url: undefined,
    headers: undefined,
    envVars: undefined,
    bearerTokenEnvVar: undefined,
    envHttpHeaders: undefined,
    enabled: false,
  });
});
