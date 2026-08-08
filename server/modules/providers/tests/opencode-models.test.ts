import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenCodeDefinitionFromVerboseModels,
  buildOpenCodeDefinitionFromIds,
  OpenCodeProviderModels,
  parseConfiguredOpenCodeModelIds,
  parseOpenCodeModelsStdout,
  parseOpenCodeVerboseModelsStdout,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

test('OpenCode models provider parses plain CLI output and removes duplicates', () => {
  const ids = parseOpenCodeModelsStdout(`
opencode/big-pickle
not a model
anthropic/claude-opus-4-7-fast
anthropic/claude-opus-4-7-fast
openai/gpt-5.5-pro
`);

  assert.deepEqual(ids, [
    'opencode/big-pickle',
    'anthropic/claude-opus-4-7-fast',
    'openai/gpt-5.5-pro',
  ]);
});

test('OpenCode models provider formats frontend labels from provider-prefixed ids', () => {
  const definition = buildOpenCodeDefinitionFromIds([
    'opencode/deepseek-v4-flash-free',
    'opencode/nemotron-3-super-free',
    'anthropic/claude-3-5-sonnet-20241022',
    'anthropic/claude-opus-4-7-fast',
    'google/model-alpha',
    'openai/gpt-5.4-mini-fast',
    'openai/gpt-5.5-pro',
    'newprovider/alpha-v12-special-20261231',
  ]);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'Deepseek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
    },
    {
      value: 'opencode/nemotron-3-super-free',
      label: 'Nemotron 3 Super Free',
      description: 'opencode - opencode/nemotron-3-super-free',
    },
    {
      value: 'anthropic/claude-3-5-sonnet-20241022',
      label: 'Claude 3.5 Sonnet (2024-10-22)',
      description: 'anthropic - anthropic/claude-3-5-sonnet-20241022',
    },
    {
      value: 'anthropic/claude-opus-4-7-fast',
      label: 'Claude Opus 4.7 Fast',
      description: 'anthropic - anthropic/claude-opus-4-7-fast',
    },
    {
      value: 'google/model-alpha',
      label: 'Model Alpha',
      description: 'google - google/model-alpha',
    },
    {
      value: 'openai/gpt-5.4-mini-fast',
      label: 'GPT-5.4 Mini Fast',
      description: 'openai - openai/gpt-5.4-mini-fast',
    },
    {
      value: 'openai/gpt-5.5-pro',
      label: 'GPT-5.5 Pro',
      description: 'openai - openai/gpt-5.5-pro',
    },
    {
      value: 'newprovider/alpha-v12-special-20261231',
      label: 'Alpha V12 Special (2026-12-31)',
      description: 'newprovider - newprovider/alpha-v12-special-20261231',
    },
  ]);
});

test('OpenCode provider exposes every model returned by the CLI to the catalog', async () => {
  const provider = new OpenCodeProviderModels(async () => `
anthropic/claude-sonnet-5
{
  "id": "claude-sonnet-5",
  "providerID": "anthropic",
  "name": "Claude Sonnet 5"
}
google/gemini-3-pro
openai/gpt-5.5
opencode/big-pickle
`, async () => []);

  const definition = await provider.getSupportedModels();

  assert.deepEqual(definition.OPTIONS.map((model) => model.value), [
    'anthropic/claude-sonnet-5',
    'google/gemini-3-pro',
    'openai/gpt-5.5',
    'opencode/big-pickle',
  ]);
});

test('OpenCode models provider reads every model from its configured provider', () => {
  const ids = parseConfiguredOpenCodeModelIds(JSON.stringify({
    provider: {
      'cloudcli-openai': {
        models: {
          'model-one': { name: 'Model One' },
          'model-two': { name: 'Model Two' },
          'upstream/model-three': { name: 'Model Three' },
        },
      },
    },
  }), 'cloudcli-openai');

  assert.deepEqual(ids, [
    'cloudcli-openai/model-one',
    'cloudcli-openai/model-two',
    'upstream/model-three',
  ]);
});

test('configured OpenCode models return immediately without invoking CLI discovery', async () => {
  const configuredIds = Array.from(
    { length: 36 },
    (_, index) => `cloudcli-openai/model-${index + 1}`,
  );
  let cliCalls = 0;
  const provider = new OpenCodeProviderModels(
    async () => {
      cliCalls += 1;
      return 'cloudcli-openai/incomplete-model';
    },
    async () => configuredIds,
  );

  const definition = await provider.getSupportedModels();

  assert.equal(definition.OPTIONS.length, 36);
  assert.deepEqual(definition.OPTIONS.map((model) => model.value), configuredIds);
  assert.equal(cliCalls, 0);
});

test('OpenCode models provider maps verbose model variants to effort options', () => {
  const models = parseOpenCodeVerboseModelsStdout(`
opencode/deepseek-v4-flash-free
{
  "id": "deepseek-v4-flash-free",
  "providerID": "opencode",
  "name": "DeepSeek V4 Flash Free",
  "variants": {
    "low": {
      "reasoningEffort": "low"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
anthropic/claude-sonnet-5
{
  "id": "claude-sonnet-5",
  "providerID": "anthropic",
  "name": "Claude Sonnet 5",
  "variants": {
    "low": {
      "effort": "low"
    },
    "max": {
      "effort": "max"
    }
  }
}
google/model-alpha
{
  "id": "model-alpha",
  "providerID": "google",
  "name": "Model Alpha"
}
`);

  const definition = buildOpenCodeDefinitionFromVerboseModels(models);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'DeepSeek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
      effort: {
        values: [
          { value: 'low' },
          { value: 'high' },
        ],
      },
    },
    {
      value: 'anthropic/claude-sonnet-5',
      label: 'Claude Sonnet 5',
      description: 'anthropic - anthropic/claude-sonnet-5',
      effort: {
        values: [
          { value: 'low' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'google/model-alpha',
      label: 'Model Alpha',
      description: 'google - google/model-alpha',
    },
  ]);
});

test('OpenCode models provider maps only positive integer limit.context metadata', () => {
  const models = parseOpenCodeVerboseModelsStdout(`
 {
   "id": "known-context",
   "providerID": "openai",
   "name": "Known Context",
   "limit": {
     "context": 128000
   }
 }
 {
   "id": "zero-context",
   "providerID": "openai",
   "limit": {
     "context": 0
   }
 }
 {
   "id": "negative-context",
   "providerID": "openai",
   "limit": {
     "context": -1
   }
 }
 {
   "id": "fractional-context",
   "providerID": "openai",
   "limit": {
     "context": 128000.5
   }
 }
 {
   "id": "string-context",
   "providerID": "openai",
   "limit": {
     "context": "128000"
   }
 }
 {
   "id": "missing-context",
   "providerID": "openai",
   "limit": {
     "output": 16000
   }
 }
 {
   "id": "no-limit",
   "providerID": "openai"
 }
 `);

  assert.deepEqual(models.map((model) => model.limit), [
    { context: 128000 },
    { context: 0 },
    { context: -1 },
    { context: 128000.5 },
    { context: '128000' },
    { output: 16000 },
    undefined,
  ]);

  const definition = buildOpenCodeDefinitionFromVerboseModels(models);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'openai/known-context',
      label: 'Known Context',
      description: 'openai - openai/known-context',
      contextWindow: 128000,
    },
    {
      value: 'openai/zero-context',
      label: 'Zero Context',
      description: 'openai - openai/zero-context',
    },
    {
      value: 'openai/negative-context',
      label: 'Negative Context',
      description: 'openai - openai/negative-context',
    },
    {
      value: 'openai/fractional-context',
      label: 'Fractional Context',
      description: 'openai - openai/fractional-context',
    },
    {
      value: 'openai/string-context',
      label: 'String Context',
      description: 'openai - openai/string-context',
    },
    {
      value: 'openai/missing-context',
      label: 'Missing Context',
      description: 'openai - openai/missing-context',
    },
    {
      value: 'openai/no-limit',
      label: 'No Limit',
      description: 'openai - openai/no-limit',
    },
  ]);
});

test('OpenCode model resolver maps an active model id to discovered context metadata', async () => {
  const provider = new OpenCodeProviderModels(async () => `
openai/known-context
{
  "id": "known-context",
  "providerID": "openai",
  "limit": { "context": 128000 }
}
openai/zero-context
{
  "id": "zero-context",
  "providerID": "openai",
  "limit": { "context": 0 }
}
openai/negative-context
{
  "id": "negative-context",
  "providerID": "openai",
  "limit": { "context": -1 }
}
`);

  assert.equal(await provider.getContextWindowForModel(' openai/known-context '), 128000);
  assert.equal(await provider.getContextWindowForModel('openai/zero-context'), undefined);
  assert.equal(await provider.getContextWindowForModel('openai/negative-context'), undefined);
  assert.equal(await provider.getContextWindowForModel('openai/unknown-context'), undefined);
  assert.equal(await provider.getContextWindowForModel(undefined), undefined);
});

test('OpenCode model resolver fails non-fatally when metadata discovery fails', async () => {
  const provider = new OpenCodeProviderModels(async () => {
    throw new Error('OpenCode CLI unavailable');
  });

  assert.equal(await provider.getContextWindowForModel('openai/known-context'), undefined);
});

test('OpenCode model resolver shares concurrent discovery and reuses successful metadata', async () => {
  let cliCalls = 0;
  let releaseDiscovery: (() => void) | undefined;
  const discoveryBlocked = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  const provider = new OpenCodeProviderModels(async () => {
    cliCalls += 1;
    await discoveryBlocked;
    return `
openai/known-context
{
  "id": "known-context",
  "providerID": "openai",
  "limit": { "context": 128000 }
}
`;
  });

  const lookups = [
    provider.getContextWindowForModel('openai/known-context'),
    provider.getContextWindowForModel('openai/known-context'),
    provider.getContextWindowForModel('openai/known-context'),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cliCalls, 1);

  releaseDiscovery?.();
  assert.deepEqual(await Promise.all(lookups), [128000, 128000, 128000]);
  assert.equal(await provider.getContextWindowForModel('openai/known-context'), 128000);
  assert.equal(cliCalls, 1);
});

test('OpenCode model resolver retries after a shared discovery failure', async () => {
  let cliCalls = 0;
  const provider = new OpenCodeProviderModels(async () => {
    cliCalls += 1;
    if (cliCalls === 1) {
      throw new Error('OpenCode CLI unavailable');
    }

    return `
openai/known-context
{
  "id": "known-context",
  "providerID": "openai",
  "limit": { "context": 64000 }
}
`;
  });

  assert.deepEqual(await Promise.all([
    provider.getContextWindowForModel('openai/known-context'),
    provider.getContextWindowForModel('openai/known-context'),
  ]), [undefined, undefined]);
  assert.equal(cliCalls, 1);
  assert.equal(await provider.getContextWindowForModel('openai/known-context'), 64000);
  assert.equal(cliCalls, 2);
});

test('OpenCode catalog discovery stays fresh while refreshing metadata reuse', async () => {
  let cliCalls = 0;
  const provider = new OpenCodeProviderModels(async () => {
    cliCalls += 1;
    return `
openai/model-${cliCalls}
{
  "id": "model-${cliCalls}",
  "providerID": "openai",
  "limit": { "context": ${cliCalls * 1000} }
}
`;
  }, async () => []);

  assert.equal((await provider.getSupportedModels()).OPTIONS[0]?.value, 'openai/model-1');
  assert.equal((await provider.getSupportedModels()).OPTIONS[0]?.value, 'openai/model-2');
  assert.equal(await provider.getContextWindowForModel('openai/model-2'), 2000);
  assert.equal(cliCalls, 2);
});

test('OpenCode models provider accepts upstream ids containing additional slashes', () => {
  assert.deepEqual(parseOpenCodeModelsStdout(`
cloudcli-openai/provider/model-name
cloudcli-openai/simple-model
`), [
    'cloudcli-openai/provider/model-name',
    'cloudcli-openai/simple-model',
  ]);
});
