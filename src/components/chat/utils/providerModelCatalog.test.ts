import assert from 'node:assert/strict';
import test from 'node:test';

import type { LLMProvider } from '../../../types/app';

import {
  loadProviderModelCatalogEntries,
  type ProviderModelCatalogEntry,
} from './providerModelCatalog';

const entry = (model: string): ProviderModelCatalogEntry => ({
  models: {
    OPTIONS: [{ value: model, label: model }],
    DEFAULT: model,
  },
  cache: {
    updatedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-06T00:00:00.000Z',
    source: 'fresh',
  },
});

test('publishes OpenCode models without waiting for another provider', async () => {
  let releaseCursor: (() => void) | undefined;
  const cursorPending = new Promise<void>((resolve) => {
    releaseCursor = resolve;
  });
  const published: Array<[LLMProvider, string]> = [];

  const completed = loadProviderModelCatalogEntries(
    ['cursor', 'opencode'],
    async (provider) => {
      if (provider === 'cursor') {
        await cursorPending;
      }
      return entry(provider === 'opencode' ? 'cloudcli-openai/model-36' : 'cursor/model');
    },
    (provider, result) => {
      published.push([provider, result.models.DEFAULT]);
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(published, [['opencode', 'cloudcli-openai/model-36']]);

  releaseCursor?.();
  await completed;
  assert.deepEqual(published, [
    ['opencode', 'cloudcli-openai/model-36'],
    ['cursor', 'cursor/model'],
  ]);
});

test('keeps successful catalogs when another provider rejects', async () => {
  const published: LLMProvider[] = [];

  await loadProviderModelCatalogEntries(
    ['claude', 'opencode'],
    async (provider) => {
      if (provider === 'claude') {
        throw new Error('Claude catalog unavailable');
      }
      return entry('cloudcli-openai/model-36');
    },
    (provider) => {
      published.push(provider);
    },
  );

  assert.deepEqual(published, ['opencode']);
});
