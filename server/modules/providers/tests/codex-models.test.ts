import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_FALLBACK_MODELS,
  CodexProviderModels,
} from '@/modules/providers/list/codex/codex-models.provider.js';

const CUSTOM_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

test('Codex fallback catalog includes all CloudCLI GPT-5.6 variants', () => {
  assert.equal(CODEX_FALLBACK_MODELS.DEFAULT, 'gpt-5.6-sol');
  assert.deepEqual(
    CODEX_FALLBACK_MODELS.OPTIONS.slice(0, CUSTOM_MODELS.length).map((model) => model.value),
    CUSTOM_MODELS,
  );
});

test('Codex uses the dynamic app-server catalog with its metadata and default', async () => {
  const provider = new CodexProviderModels(
    '/missing/models_cache.json',
    '/missing/config.toml',
    async () => [
      {
        id: 'gpt-5.6-terra',
        model: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra live',
        description: 'Live model metadata',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          { reasoningEffort: 'medium', description: 'Balanced' },
        ],
      },
      {
        id: 'hidden-model',
        model: 'hidden-model',
        displayName: 'Hidden',
        hidden: true,
        isDefault: false,
        supportedReasoningEfforts: [],
      },
    ],
  );

  const models = await provider.getSupportedModels();

  assert.equal(models.DEFAULT, 'gpt-5.6-terra');
  assert.deepEqual(models.OPTIONS, [
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra live',
      description: 'Live model metadata',
      effort: {
        default: 'medium',
        values: [
          { value: 'low', description: 'Fast' },
          { value: 'medium', description: 'Balanced' },
        ],
      },
    },
  ]);
});

test('Codex falls back to its local cache when app-server discovery fails', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-codex-models-'));
  const modelsCachePath = path.join(tempRoot, 'models_cache.json');
  const configPath = path.join(tempRoot, 'config.toml');

  try {
    await writeFile(modelsCachePath, JSON.stringify({
      models: [
        {
          slug: 'gpt-5.4',
          display_name: 'GPT-5.4 from cache',
          priority: 1,
          visibility: 'list',
          supported_in_api: true,
        },
        {
          slug: 'gpt-5.6-terra',
          display_name: 'GPT-5.6 Terra from cache',
          priority: 2,
          visibility: 'list',
          supported_in_api: true,
        },
        {
          slug: 'hidden-model',
          priority: 3,
          visibility: 'hide',
          supported_in_api: true,
        },
      ],
    }));

    const provider = new CodexProviderModels(
      modelsCachePath,
      configPath,
      async () => { throw new Error('app-server unavailable'); },
    );
    const models = await provider.getSupportedModels();

    assert.equal(models.DEFAULT, 'gpt-5.4');
    assert.deepEqual(models.OPTIONS.map((model) => model.value), [
      'gpt-5.4',
      'gpt-5.6-terra',
    ]);
    assert.equal(models.OPTIONS[1]?.label, 'GPT-5.6 Terra from cache');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
