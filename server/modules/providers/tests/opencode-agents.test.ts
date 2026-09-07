import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OpenCodeAgentsProvider } from '@/modules/providers/list/opencode/opencode-agents.provider.js';
import { OpenCodeConfigStore } from '@/modules/providers/list/opencode/opencode-config.provider.js';

const withTempConfig = async (
  run: (directory: string, provider: OpenCodeAgentsProvider) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-agents-'));
  try {
    const store = new OpenCodeConfigStore({ userConfigDirectory: directory });
    await run(directory, new OpenCodeAgentsProvider(store));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test('OpenCode agents list global definitions and expose pass-through options', async () => {
  await withTempConfig(async (directory, provider) => {
    await writeFile(path.join(directory, 'opencode.jsonc'), `{
      // Existing comments and trailing commas are accepted.
      "agent": {
        "review": {
          "description": "Reviews code",
          "mode": "subagent",
          "top_p": 0.8,
          "permission": {
            "bash": { "*": "ask", "git diff*": "allow", },
          },
          "tools": { "write": false },
          "reasoningEffort": "high",
          "maxSteps": 9,
        },
      },
    }`, 'utf8');

    const agents = await provider.listAgents();

    assert.equal(agents.length, 1);
    assert.deepEqual(agents[0], {
      name: 'review',
      description: 'Reviews code',
      mode: 'subagent',
      model: undefined,
      prompt: undefined,
      temperature: undefined,
      topP: 0.8,
      steps: undefined,
      disable: undefined,
      hidden: undefined,
      color: undefined,
      permission: { bash: { '*': 'ask', 'git diff*': 'allow' } },
      tools: { write: false },
      options: { reasoningEffort: 'high', maxSteps: 9 },
    });
  });
});

test('OpenCode runtime agents hide disabled/hidden entries and sort custom agents first', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-agent-list-'));
  try {
    const store = new OpenCodeConfigStore({ userConfigDirectory: directory });
    await writeFile(path.join(directory, 'opencode.json'), JSON.stringify({
      agent: {
        reviewer: { description: 'Reviews changes', mode: 'primary' },
      },
    }), 'utf8');
    let receivedWorkspacePath: string | undefined;
    const detailsWorkspacePaths: Array<string | undefined> = [];
    const provider = new OpenCodeAgentsProvider(
      store,
      async (workspacePath) => {
        receivedWorkspacePath = workspacePath;
        return [
          'build (primary)',
          '  [{ "permission": "*" }]',
          'reviewer (primary)',
          '  []',
          'explore (subagent)',
          '  []',
          'summary (primary)',
          '  []',
        ].join('\n');
      },
      async (name, workspacePath) => {
        detailsWorkspacePaths.push(workspacePath);
        return JSON.stringify({
          name,
          mode: name === 'reviewer' ? 'all' : undefined,
          native: name !== 'reviewer',
          hidden: name === 'summary',
          disable: name === 'explore',
          description: name === 'reviewer' ? 'Reviews changes' : undefined,
          model: name === 'reviewer' ? { providerID: 'openai', modelID: 'gpt-5' } : undefined,
          options: name === 'reviewer' ? { reasoningEffort: 'high' } : undefined,
        });
      },
    );

    const agents = await provider.listAvailableAgents({ workspacePath: '/workspace/project' });

    assert.equal(receivedWorkspacePath, '/workspace/project');
    assert.deepEqual(detailsWorkspacePaths, Array(4).fill('/workspace/project'));
    assert.deepEqual(agents, [
      { name: 'reviewer', mode: 'all', description: 'Reviews changes', model: 'openai/gpt-5', reasoningEffort: 'high' },
      { name: 'build', mode: 'primary', description: undefined, model: undefined, reasoningEffort: undefined },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OpenCode runtime agent discovery coalesces by workspace, bounds details, refreshes, and recovers from failures', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-agent-cache-'));
  try {
    const store = new OpenCodeConfigStore({ userConfigDirectory: directory });
    let listCalls = 0;
    let activeDetails = 0;
    let peakDetails = 0;
    let generation = 0;
    let failNext = false;
    const provider = new OpenCodeAgentsProvider(
      store,
      async (workspacePath) => {
        listCalls += 1;
        if (failNext) {
          failNext = false;
          throw new Error('transient list failure');
        }
        generation += 1;
        return Array.from({ length: 9 }, (_, index) => `${workspacePath?.slice(-1) ?? 'g'}-${generation}-${index} (primary)`).join('\n');
      },
      async (name) => {
        activeDetails += 1;
        peakDetails = Math.max(peakDetails, activeDetails);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeDetails -= 1;
        return JSON.stringify({ name, native: name.endsWith('-0'), description: `Details ${name}` });
      },
    );

    const [first, duplicate] = await Promise.all([
      provider.listAvailableAgents({ workspacePath: '/workspace/a' }),
      provider.listAvailableAgents({ workspacePath: '/workspace/a' }),
    ]);
    assert.deepEqual(duplicate, first);
    assert.equal(listCalls, 1);
    assert.equal(peakDetails, 4);
    assert.equal(first.at(-1)?.name, 'a-1-0', 'native agents remain after custom agents');

    const otherWorkspace = await provider.listAvailableAgents({ workspacePath: '/workspace/b' });
    assert.equal(listCalls, 2);
    assert.match(otherWorkspace[0].name, /^b-2-/);
    assert.deepEqual(await provider.listAvailableAgents({ workspacePath: '/workspace/a' }), first);
    assert.equal(listCalls, 2, 'workspace result is cached independently');

    const refreshed = await provider.listAvailableAgents({ workspacePath: '/workspace/a', refresh: true });
    assert.equal(listCalls, 3);
    assert.match(refreshed[0].name, /^a-3-/);

    failNext = true;
    await assert.rejects(
      provider.listAvailableAgents({ workspacePath: '/workspace/failure', refresh: true }),
      /transient list failure/,
    );
    const recovered = await provider.listAvailableAgents({ workspacePath: '/workspace/failure' });
    assert.match(recovered[0].name, /^e-4-/);
    assert.equal(listCalls, 5, 'failed discovery leaves no poisoned result or in-flight entry');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OpenCode agent mutations invalidate cached runtime catalogs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-agent-invalidation-'));
  try {
    const store = new OpenCodeConfigStore({ userConfigDirectory: directory });
    let listCalls = 0;
    const provider = new OpenCodeAgentsProvider(
      store,
      async () => {
        listCalls += 1;
        return 'code (primary)';
      },
      async () => JSON.stringify({ native: false }),
    );
    await provider.listAvailableAgents();
    await provider.listAvailableAgents();
    assert.equal(listCalls, 1);

    await provider.upsertAgent({ name: 'code', description: 'Code', mode: 'primary', options: {} });
    await provider.listAvailableAgents();
    await provider.updateAgentPreferences('code', { reasoningEffort: 'high' });
    await provider.listAvailableAgents();
    await provider.removeAgent('code');
    await provider.listAvailableAgents();
    assert.equal(listCalls, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OpenCode agent preference patches preserve unrelated config and clear default reasoning', { concurrency: false }, async () => {
  const previousProvider = process.env.CLOUDCLI_OPENCODE_PROVIDER_ID;
  process.env.CLOUDCLI_OPENCODE_PROVIDER_ID = 'cloudcli-openai';
  try {
    await withTempConfig(async (directory, provider) => {
      const configPath = path.join(directory, 'opencode.json');
      await writeFile(configPath, JSON.stringify({
        $schema: 'schema', mcp: { docs: { enabled: true } },
        agent: {
          code: { description: 'Code', prompt: 'Keep', permission: { bash: 'ask' }, model: 'old/model', reasoningEffort: 'low', custom: 7 },
          other: { description: 'Other', model: 'other/model' },
        },
      }), 'utf8');

      assert.deepEqual(await provider.updateAgentPreferences('code', { model: 'gpt-new' }), {
        provider: 'opencode', name: 'code', model: 'cloudcli-openai/gpt-new', reasoningEffort: 'low',
      });
      assert.deepEqual(await provider.updateAgentPreferences('code', { reasoningEffort: 'high' }), {
        provider: 'opencode', name: 'code', model: 'cloudcli-openai/gpt-new', reasoningEffort: 'high',
      });
      assert.deepEqual(await provider.updateAgentPreferences('code', { model: 'openai/gpt-5', reasoningEffort: 'default' }), {
        provider: 'opencode', name: 'code', model: 'openai/gpt-5', reasoningEffort: undefined,
      });

      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
      assert.deepEqual(config, {
        $schema: 'schema', mcp: { docs: { enabled: true } },
        agent: {
          code: { description: 'Code', prompt: 'Keep', permission: { bash: 'ask' }, model: 'openai/gpt-5', custom: 7 },
          other: { description: 'Other', model: 'other/model' },
        },
      });
      await assert.rejects(provider.updateAgentPreferences('missing', { model: 'openai/gpt-5' }), /not found or is not configurable/);
      await assert.rejects(provider.updateAgentPreferences('code', {}), /At least one/);
    });
  } finally {
    if (previousProvider === undefined) delete process.env.CLOUDCLI_OPENCODE_PROVIDER_ID;
    else process.env.CLOUDCLI_OPENCODE_PROVIDER_ID = previousProvider;
  }
});

test('OpenCode agent writes preserve MCP configuration and support rename and delete', async () => {
  await withTempConfig(async (directory, provider) => {
    const configPath = path.join(directory, 'opencode.json');
    await writeFile(configPath, JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        docs: { type: 'remote', url: 'https://example.com/mcp', enabled: true },
      },
      agent: {
        old: { description: 'Old agent', mode: 'all' },
      },
    }), 'utf8');

    const saved = await provider.upsertAgent({
      originalName: 'old',
      name: 'reviewer',
      description: 'Reviews code for correctness',
      mode: 'subagent',
      model: 'openai/gpt-5',
      prompt: 'Review without editing.',
      temperature: 0.1,
      topP: 0.9,
      steps: 7,
      disable: false,
      hidden: true,
      color: '#ff6b6b',
      permission: {
        edit: 'deny',
        bash: { '*': 'ask', 'git diff*': 'allow' },
        'mymcp_*': 'deny',
      },
      tools: { write: false },
      options: { reasoningEffort: 'high', textVerbosity: 'low' },
    });

    assert.equal(saved.name, 'reviewer');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.deepEqual(config.mcp, {
      docs: { type: 'remote', url: 'https://example.com/mcp', enabled: true },
    });
    assert.equal(config.agent.old, undefined);
    assert.deepEqual(config.agent.reviewer, {
      reasoningEffort: 'high',
      textVerbosity: 'low',
      description: 'Reviews code for correctness',
      mode: 'subagent',
      model: 'openai/gpt-5',
      prompt: 'Review without editing.',
      temperature: 0.1,
      top_p: 0.9,
      steps: 7,
      disable: false,
      hidden: true,
      color: '#ff6b6b',
      permission: {
        edit: 'deny',
        bash: { '*': 'ask', 'git diff*': 'allow' },
        'mymcp_*': 'deny',
      },
      tools: { write: false },
    });

    assert.deepEqual(await provider.removeAgent('reviewer'), {
      removed: true,
      provider: 'opencode',
      name: 'reviewer',
    });
    const afterDelete = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.deepEqual(afterDelete.mcp, config.mcp);
    assert.deepEqual(afterDelete.agent, {});
  });
});

test('OpenCode agent writes qualify bare models with the CloudCLI provider', { concurrency: false }, async () => {
  const previousProvider = process.env.CLOUDCLI_OPENCODE_PROVIDER_ID;
  process.env.CLOUDCLI_OPENCODE_PROVIDER_ID = 'cloudcli-openai';

  try {
    await withTempConfig(async (directory, provider) => {
      const saved = await provider.upsertAgent({
        name: 'code',
        description: 'Writes code',
        mode: 'subagent',
        model: 'gpt-5.6-luna',
        options: {},
      });

      assert.equal(saved.model, 'cloudcli-openai/gpt-5.6-luna');
      const config = JSON.parse(
        await readFile(path.join(directory, 'opencode.json'), 'utf8'),
      ) as Record<string, any>;
      assert.equal(config.agent.code.model, 'cloudcli-openai/gpt-5.6-luna');
    });
  } finally {
    if (previousProvider === undefined) {
      delete process.env.CLOUDCLI_OPENCODE_PROVIDER_ID;
    } else {
      process.env.CLOUDCLI_OPENCODE_PROVIDER_ID = previousProvider;
    }
  }
});

test('OpenCode agent validation rejects invalid documented fields and rename collisions', async () => {
  await withTempConfig(async (_directory, provider) => {
    await assert.rejects(
      provider.upsertAgent({
        name: 'bad/name',
        description: 'Invalid name',
        mode: 'all',
        options: {},
      }),
      /name must be 1-120 characters/,
    );
    await assert.rejects(
      provider.upsertAgent({
        name: 'creative',
        description: 'Creative agent',
        mode: 'all',
        temperature: 1.5,
        options: {},
      }),
      /temperature must be a number between 0 and 1/,
    );
    await assert.rejects(
      provider.upsertAgent({
        name: 'review',
        description: 'Review agent',
        mode: 'subagent',
        permission: { bash: { '*': 'sometimes' as 'allow' } },
        options: {},
      }),
      /permission\.bash pattern values/,
    );
    await assert.rejects(
      provider.upsertAgent({
        name: 'bad-model',
        description: 'Invalid model reference',
        mode: 'subagent',
        model: 'provider/',
        options: {},
      }),
      /model must use provider\/model-id format/,
    );

    await provider.upsertAgent({ name: 'one', description: 'One', mode: 'all', options: {} });
    await provider.upsertAgent({ name: 'two', description: 'Two', mode: 'all', options: {} });
    await assert.rejects(
      provider.upsertAgent({
        originalName: 'one',
        name: 'two',
        description: 'Collision',
        mode: 'all',
        options: {},
      }),
      /already exists/,
    );
  });
});
