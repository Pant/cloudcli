import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { AppError } from '@/shared/utils.js';

function createSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'app-session',
    provider: 'claude',
    provider_session_id: 'provider-session',
    project_path: null,
    jsonl_path: null,
    custom_name: null,
    model: null,
    agent: null,
    provider_parent_session_id: null,
    isArchived: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('token usage lookup requires only the app-facing session id for Claude', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 30,
          },
        },
      }),
      '{incomplete',
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 155,
      total: 180_000,
      windowTokens: 155,
      inputTokens: 125,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      cacheTokens: 25,
      breakdown: { input: 125, output: 30 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Claude cumulative result usage does not expose windowTokens', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-result-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, JSON.stringify({
      type: 'result',
      usage: { input_tokens: 420, output_tokens: 80 },
      modelUsage: {
        'claude-sonnet': { cumulativeInputTokens: 420, cumulativeOutputTokens: 80 },
      },
    }));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
    });
    const result = await service.getSessionTokenUsage('app-session');
    assert.deepEqual(result, {
      used: 500,
      total: 180_000,
      inputTokens: 420,
      outputTokens: 80,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheTokens: 0,
      breakdown: { input: 420, output: 80 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Claude token usage aggregates every assistant response but keeps latest context window', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-cumulative-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 100, output_tokens: 20 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 30, cache_read_input_tokens: 5, output_tokens: 7 } },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 162,
      total: 180_000,
      windowTokens: 42,
      inputTokens: 135,
      outputTokens: 27,
      cacheReadTokens: 5,
      cacheCreationTokens: 0,
      cacheTokens: 5,
      breakdown: { input: 135, output: 27 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage uses the latest token_count snapshot', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            last_token_usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
            model_context_window: 100_000,
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 },
            last_token_usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
            model_context_window: 250_000,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: sessionFilePath,
      }),
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 49,
      total: 250_000,
      windowTokens: 15,
      inputTokens: 40,
      outputTokens: 9,
      breakdown: { input: 40, output: 9 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage omits windowTokens when the latest-call snapshot is malformed', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-malformed-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 },
          last_token_usage: { input_tokens: 'not-a-number' },
          model_context_window: 250_000,
        },
      },
    }));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'codex', jsonl_path: sessionFilePath }),
    });

    const result = await service.getSessionTokenUsage('app-session');
    assert.equal(result.used, 49);
    assert.equal(Object.hasOwn(result, 'windowTokens'), false);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('OpenCode token usage resolves its provider-native id from the session row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      )
      ;
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      )
    `);
    database.prepare(`
      INSERT INTO session (
        id,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('provider-session', 12, 7, 3, 5, 2);
    database.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('assistant-message-old', 'provider-session', 1, JSON.stringify({
        role: 'assistant',
        tokens: { input: 40, output: 10, reasoning: 2, cache: { read: 3, write: 1 } },
      }));
    database.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('assistant-message-latest', 'provider-session', 2, JSON.stringify({
        role: 'assistant',
        tokens: {
          total: 160_626,
          input: 1_029,
          output: 365,
          reasoning: 0,
          cache: { read: 159_232, write: 0 },
        },
      }));
    database.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('assistant-message-bookkeeping', 'provider-session', 3, JSON.stringify({
        role: 'assistant',
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }));
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      getOpenCodeDatabasePath: () => databasePath,
      resolveOpenCodeSessionModel: async (sessionId) => {
        assert.equal(sessionId, 'app-session');
        return 'openai/known-context';
      },
      resolveOpenCodeContextWindow: async (modelId) => {
        assert.equal(modelId, 'openai/known-context');
        return 128_000;
      },
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 29,
      total: 128_000,
      windowTokens: 160_626,
      inputTokens: 17,
      outputTokens: 7,
      breakdown: { input: 17, output: 7 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('OpenCode token usage reports zero current-window tokens for genuinely empty data', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-empty-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      )
    `);
    database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)')
      .run('provider-session', 0, 0, 0, 0, 0);
    database.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('assistant-empty', 'provider-session', 1, JSON.stringify({
        role: 'assistant',
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }));
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      getOpenCodeDatabasePath: () => databasePath,
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 0,
      windowTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      breakdown: { input: 0, output: 0 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('OpenCode token usage omits an unknown context maximum', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-unknown-context-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      )
    `);
    database.prepare(`
      INSERT INTO session (
        id,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('provider-session', 12, 7, 3, 5, 2);
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      getOpenCodeDatabasePath: () => databasePath,
      resolveOpenCodeSessionModel: async () => 'openai/unknown-context',
      resolveOpenCodeContextWindow: async () => 0,
    });

    const result = await service.getSessionTokenUsage('app-session');

    assert.deepEqual(result, {
      used: 29,
      inputTokens: 17,
      outputTokens: 7,
      breakdown: { input: 17, output: 7 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('OpenCode token usage omits windowTokens for old schemas without message storage', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-old-schema-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      )
    `);
    database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)')
      .run('provider-session', 12, 7, 3, 5, 2);
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      getOpenCodeDatabasePath: () => databasePath,
    });
    const result = await service.getSessionTokenUsage('app-session');
    assert.equal(result.used, 29);
    assert.equal(Object.hasOwn(result, 'windowTokens'), false);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('OpenCode token usage keeps counters when context metadata resolution fails', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-context-failure-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      )
    `);
    database.prepare(`
      INSERT INTO session (
        id,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('provider-session', 12, 7, 3, 5, 2);
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      getOpenCodeDatabasePath: () => databasePath,
      resolveOpenCodeSessionModel: async () => 'openai/known-context',
      resolveOpenCodeContextWindow: async () => {
        throw new Error('metadata lookup failed');
      },
    });

    const result = await service.getSessionTokenUsage('app-session');

    assert.deepEqual(result, {
      used: 29,
      inputTokens: 17,
      outputTokens: 7,
      breakdown: { input: 17, output: 7 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('OpenCode token usage is unavailable rather than 404 when provider storage is missing', async () => {
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({ provider: 'opencode' }),
    getOpenCodeDatabasePath: () => '/missing/opencode.db',
    fileExists: () => false,
  });

  const result = await service.getSessionTokenUsage('app-session');

  assert.equal(result.unsupported, true);
  assert.equal(result.used, 0);
  assert.match(result.message ?? '', /database was not found/i);
});

test('OpenCode token usage is unavailable rather than 404 for an unretained session row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-missing-session-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      )
    `);
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      getOpenCodeDatabasePath: () => databasePath,
    });

    const result = await service.getSessionTokenUsage('app-session');

    assert.equal(result.unsupported, true);
    assert.equal(result.used, 0);
    assert.match(result.message ?? '', /not present in provider storage/i);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Cursor returns an explicit unsupported token usage result', async () => {
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({ provider: 'cursor' }),
  });

  const result = await service.getSessionTokenUsage('app-session');

  assert.equal(result.unsupported, true);
  assert.equal(result.used, 0);
  assert.equal(result.total, 0);
});

test('token usage reports SESSION_NOT_FOUND for an unknown app session id', async () => {
  const service = createProviderTokenUsageService({ getSessionById: () => null });

  await assert.rejects(
    () => service.getSessionTokenUsage('missing-session'),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'SESSION_NOT_FOUND'
      && error.statusCode === 404
    ),
  );
});
