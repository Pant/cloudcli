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
