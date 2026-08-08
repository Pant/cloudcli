import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeError,
  ProviderRuntimeResult,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  getOpenCodeRuntimeDiagnostic,
  opencodeRuntime,
  resolveOpenCodePermissionOptions,
} from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { createOpenCodeRunDiagnostics } from '@/modules/providers/list/opencode/opencode-run-diagnostics.provider.js';

const sessionsProvider = new OpenCodeSessionsProvider();
const runtimeContext: ProviderRuntimeContext = {
  resolveProviderSessionId: (sessionId: string | null | undefined) => sessionId || null,
  resolveResumeModel: async (_sessionId: string | undefined, requestedModel?: string | null) => (
    requestedModel || undefined
  ),
  resolveContextWindow: async () => undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw: unknown, sessionId: string | null) => (
    sessionsProvider.normalizeMessage(raw, sessionId)
  ),
  isProviderInstalled: async () => true,
};

type TestWriter = ProviderRuntimeWriter & { sessionId: string | null };

const findEnvKey = (name: string): string =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function withEnvironment(
  values: Record<string, string | undefined>,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function createFakeOpenCodeExecutable(binDir: string): Promise<void> {
  const scriptPath = path.join(binDir, 'opencode.js');
  await writeFile(scriptPath, `
const capturePath = process.env.OPENCODE_ARGS_CAPTURE;
if (capturePath) {
  require('node:fs').writeFileSync(capturePath, JSON.stringify({
    args: process.argv.slice(2),
    permissionEnv: process.env.OPENCODE_PERMISSION ?? null,
  }));
}

const events = [
  { type: 'text', sessionID: 'open-live-1', text: 'assistant response' },
  { type: 'step_finish', sessionID: 'open-live-1' },
];

if (process.env.OPENCODE_TEST_STDERR) process.stderr.write(process.env.OPENCODE_TEST_STDERR);
if (process.env.OPENCODE_TEST_SIGNAL === 'SIGTERM') {
  process.kill(process.pid, 'SIGTERM');
  setInterval(() => {}, 1000);
}
if (process.env.OPENCODE_TEST_WAIT === '1') setInterval(() => {}, 1000);

for (const event of events) {
  console.log(JSON.stringify(event));
}
`, 'utf8');

  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, 'opencode.cmd');
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0opencode.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/opencode.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

async function createOpenCodeUsageDatabase(
  homeDirectory: string,
  options: { empty?: boolean } = {},
): Promise<void> {
  const databaseDirectory = path.join(homeDirectory, '.local', 'share', 'opencode');
  await mkdir(databaseDirectory, { recursive: true });
  const databasePath = path.join(databaseDirectory, 'opencode.db');
  const database = new Database(databasePath);
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
  const totals = options.empty ? [0, 0, 0, 0, 0] : [12, 7, 3, 5, 2];
  database.prepare(`
    INSERT INTO session (
      id,
      tokens_input,
      tokens_output,
      tokens_reasoning,
      tokens_cache_read,
      tokens_cache_write
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('open-live-1', ...totals);
  database.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    .run('assistant-live-1', 'open-live-1', 1, JSON.stringify({
      role: 'assistant',
      tokens: options.empty
        ? { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        : {
            total: 160_626,
            input: 1_029,
            output: 365,
            reasoning: 0,
            cache: { read: 159_232, write: 0 },
          },
    }));
  if (!options.empty) {
    database.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('assistant-live-bookkeeping', 'open-live-1', 2, JSON.stringify({
        role: 'assistant',
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }));
  }
  database.close();
}

test('spawnOpenCode emits session_created before normalized live messages for new sessions', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-live-'));
  const argsCapturePath = path.join(tempRoot, 'opencode-args.json');
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const messages: AnyRecord[] = [];
  const writer: TestWriter = {
    userId: null,
    sessionId: null,
    send(message: unknown) {
      messages.push(message as AnyRecord);
    },
    setSessionId(sessionId: string) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);

    const sessionCreatedIndex = messages.findIndex((message) => message.kind === 'session_created');
    const assistantDeltaIndex = messages.findIndex((message) =>
      message.kind === 'stream_delta' && message.content === 'assistant response',
    );
    const streamEnd = messages.find((message) => message.kind === 'stream_end');
    const complete = messages.find((message) => message.kind === 'complete');

    assert.notEqual(sessionCreatedIndex, -1);
    assert.notEqual(assistantDeltaIndex, -1);
    assert.ok(sessionCreatedIndex < assistantDeltaIndex);
    assert.equal(messages[sessionCreatedIndex].newSessionId, 'open-live-1');
    assert.equal(writer.sessionId, 'open-live-1');
    assert.equal(streamEnd?.sessionId, 'open-live-1');
    assert.equal(complete?.sessionId, 'open-live-1');
    assert.equal(messages.some((message) => message.kind === 'error'), false);

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8')) as AnyRecord;
    const launchedArgs = capture.args;
    assert.ok(Array.isArray(launchedArgs));
    assert.deepEqual(launchedArgs.slice(0, 4), ['run', '--format', 'json', '--dir']);
    assert.equal(launchedArgs[4], tempRoot);
    // No permission mode requested → no permission flags and no env override.
    assert.equal(launchedArgs.includes('--auto'), false);
    assert.equal(launchedArgs.includes('--agent'), false);
    assert.equal(capture.permissionEnv, null);

    const attachmentOnlyCapturePath = path.join(tempRoot, 'opencode-attachment-only.json');
    process.env.OPENCODE_ARGS_CAPTURE = attachmentOnlyCapturePath;
    await opencodeRuntime.run(
      '',
      {
        cwd: tempRoot,
        files: [{
          path: path.join(tempRoot, 'brief.pdf'),
          name: 'brief.pdf',
          mimeType: 'application/pdf',
        }],
      },
      writer,
      runtimeContext,
    );
    const attachmentOnlyCapture = JSON.parse(
      await readFile(attachmentOnlyCapturePath, 'utf8'),
    ) as AnyRecord;
    const attachmentPrompt = attachmentOnlyCapture.args[attachmentOnlyCapture.args.length - 1];
    assert.match(attachmentPrompt, /<files_input>/);
    assert.match(attachmentPrompt, /brief\.pdf/);
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    if (previousArgsCapture === undefined) {
      delete process.env.OPENCODE_ARGS_CAPTURE;
    } else {
      process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('pending app sessions launch fresh with the exact queued prompt', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-pending-'));
  const argsCapturePath = path.join(tempRoot, 'opencode-pending-args.json');
  const pathKey = findEnvKey('PATH');
  const previousPath = process.env[pathKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const queuedPrompt = 'Queued appointment prompt: preserve spacing & punctuation!';

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;

    await opencodeRuntime.run(
      queuedPrompt,
      { cwd: tempRoot, sessionId: 'pending-app-id' },
      { userId: null, send() {} },
      { ...runtimeContext, resolveProviderSessionId: () => null },
    );

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8')) as AnyRecord;
    assert.equal(capture.args.includes('--session'), false);
    assert.equal(capture.args[capture.args.length - 1], queuedPrompt);
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousArgsCapture === undefined) delete process.env.OPENCODE_ARGS_CAPTURE;
    else process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runtime diagnostics distinguish missing and exited processes without exposing handles', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-diagnostics-'));
  const pathKey = findEnvKey('PATH');
  const previousPath = process.env[pathKey];
  const writer: TestWriter = { userId: null, sessionId: 'diagnostic-app', send() {} };
  try {
    assert.deepEqual(getOpenCodeRuntimeDiagnostic('never-started'), {
      state: 'missing', startedAt: null, lastOutputAt: null, exitCode: null, signal: null,
    });
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    await opencodeRuntime.run('diagnose', { cwd: tempRoot, sessionId: 'diagnostic-app' }, writer, runtimeContext);
    const diagnostic = getOpenCodeRuntimeDiagnostic('diagnostic-app');
    assert.equal(diagnostic.state, 'exited');
    assert.equal(diagnostic.exitCode, 0);
    assert.equal(typeof diagnostic.startedAt, 'number');
    assert.equal(typeof diagnostic.lastOutputAt, 'number');
    assert.deepEqual(Object.keys(diagnostic).sort(), ['exitCode', 'lastOutputAt', 'signal', 'startedAt', 'state']);
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('spawnOpenCode attaches a known context maximum to the live token budget event', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-token-budget-known-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const homeKey = findEnvKey('HOME');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousHome = process.env[homeKey];
  const messages: AnyRecord[] = [];
  const writer: TestWriter = {
    userId: null,
    sessionId: null,
    send(message: unknown) {
      messages.push(message as AnyRecord);
    },
    setSessionId(sessionId: string) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await createOpenCodeUsageDatabase(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env[homeKey] = tempRoot;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await opencodeRuntime.run(
      'Use the known model',
      { cwd: tempRoot, model: 'openai/known-context' },
      writer,
      {
        ...runtimeContext,
        resolveContextWindow: async (modelId) => {
          assert.equal(modelId, 'openai/known-context');
          return 128_000;
        },
      },
    );

    const tokenBudgetMessage = messages.find((message) => message.text === 'token_budget');
    assert.deepEqual(tokenBudgetMessage?.tokenBudget, {
      used: 29,
      total: 128_000,
      windowTokens: 160_626,
      inputTokens: 17,
      outputTokens: 7,
      breakdown: { input: 17, output: 7 },
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }
    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }
    if (previousHome === undefined) {
      delete process.env[homeKey];
    } else {
      process.env[homeKey] = previousHome;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('spawnOpenCode keeps the live token budget current-only when context metadata is unavailable', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-token-budget-unknown-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const homeKey = findEnvKey('HOME');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousHome = process.env[homeKey];
  const messages: AnyRecord[] = [];
  const writer: TestWriter = {
    userId: null,
    sessionId: null,
    send(message: unknown) {
      messages.push(message as AnyRecord);
    },
    setSessionId(sessionId: string) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await createOpenCodeUsageDatabase(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env[homeKey] = tempRoot;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    const scenarios = [
      {
        model: 'openai/zero-context',
        resolveContextWindow: async () => 0,
      },
      {
        model: 'openai/context-lookup-failure',
        resolveContextWindow: async () => {
          throw new Error('context metadata unavailable');
        },
      },
    ];

    for (const scenario of scenarios) {
      messages.length = 0;
      await opencodeRuntime.run(
        'Use the unavailable model',
        { cwd: tempRoot, model: scenario.model },
        writer,
        {
          ...runtimeContext,
          resolveContextWindow: async (modelId) => {
            assert.equal(modelId, scenario.model);
            return scenario.resolveContextWindow();
          },
        },
      );

      const tokenBudgetMessage = messages.find((message) => message.text === 'token_budget');
      assert.deepEqual(tokenBudgetMessage?.tokenBudget, {
      used: 29,
       windowTokens: 160_626,
      inputTokens: 17,
        outputTokens: 7,
        breakdown: { input: 17, output: 7 },
      });
      assert.equal(Object.hasOwn(tokenBudgetMessage?.tokenBudget ?? {}, 'total'), false);
      assert.equal(messages.some((message) => message.kind === 'error'), false);
      assert.equal(messages.some((message) => message.kind === 'complete'), true);
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }
    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }
    if (previousHome === undefined) {
      delete process.env[homeKey];
    } else {
      process.env[homeKey] = previousHome;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('spawnOpenCode publishes a zero live token snapshot for genuinely empty data', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-token-budget-empty-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const homeKey = findEnvKey('HOME');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousHome = process.env[homeKey];
  const messages: AnyRecord[] = [];
  const writer: TestWriter = {
    userId: null,
    sessionId: null,
    send(message: unknown) {
      messages.push(message as AnyRecord);
    },
    setSessionId(sessionId: string) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await createOpenCodeUsageDatabase(tempRoot, { empty: true });
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env[homeKey] = tempRoot;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await opencodeRuntime.run('Start empty', { cwd: tempRoot }, writer, runtimeContext);

    const tokenBudgetMessage = messages.find((message) => message.text === 'token_budget');
    assert.deepEqual(tokenBudgetMessage?.tokenBudget, {
      used: 0,
      windowTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      breakdown: { input: 0, output: 0 },
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }
    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }
    if (previousHome === undefined) {
      delete process.env[homeKey];
    } else {
      process.env[homeKey] = previousHome;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveOpenCodePermissionOptions maps UI permission modes onto OpenCode controls', () => {
  assert.deepEqual(resolveOpenCodePermissionOptions('plan'), {
    args: ['--agent', 'plan'],
    env: {},
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('bypassPermissions'), {
    args: ['--auto'],
    env: {},
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('acceptEdits'), {
    args: [],
    env: { OPENCODE_PERMISSION: '{"edit":"allow"}' },
  });
  // default and anything unknown leave the user's own opencode config in charge.
  assert.deepEqual(resolveOpenCodePermissionOptions('default'), { args: [], env: {} });
  assert.deepEqual(resolveOpenCodePermissionOptions(undefined), { args: [], env: {} });
});

test('spawnOpenCode passes the selected composer agent to the CLI', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-agent-'));
  const argsCapturePath = path.join(tempRoot, 'opencode-agent-args.json');
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const writer: TestWriter = {
    userId: null,
    sessionId: null,
    send() {},
    setSessionId(sessionId: string) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await opencodeRuntime.run(
      'Review this',
      { cwd: tempRoot, agent: 'reviewer', effort: 'high' },
      writer,
      runtimeContext,
    );

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8')) as AnyRecord;
    const agentFlagIndex = capture.args.indexOf('--agent');
    assert.notEqual(agentFlagIndex, -1);
    assert.equal(capture.args[agentFlagIndex + 1], 'reviewer');
    const variantFlagIndex = capture.args.indexOf('--variant');
    assert.notEqual(variantFlagIndex, -1);
    assert.equal(capture.args[variantFlagIndex + 1], 'high');
    assert.equal(capture.args[capture.args.length - 1], 'Review this');
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }
    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }
    if (previousArgsCapture === undefined) {
      delete process.env.OPENCODE_ARGS_CAPTURE;
    } else {
      process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('spawnOpenCode passes permission mode flags and env to the CLI', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-perms-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const writer: TestWriter = {
    userId: null,
    sessionId: null,
    send() {},
    setSessionId(sessionId: string) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    const scenarios = [
      {
        permissionMode: 'plan',
        expectArgs: ['--agent', 'plan'],
        expectPermissionEnv: null,
      },
      {
        permissionMode: 'bypassPermissions',
        expectArgs: ['--auto'],
        expectPermissionEnv: null,
      },
      {
        permissionMode: 'acceptEdits',
        expectArgs: [],
        expectPermissionEnv: '{"edit":"allow"}',
      },
    ];

    for (const scenario of scenarios) {
      const argsCapturePath = path.join(tempRoot, `opencode-args-${scenario.permissionMode}.json`);
      process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;

      await opencodeRuntime.run(
        'Hi',
        { cwd: tempRoot, permissionMode: scenario.permissionMode },
        writer,
        runtimeContext,
      );

      const capture = JSON.parse(await readFile(argsCapturePath, 'utf8')) as AnyRecord;
      for (const expectedArg of scenario.expectArgs) {
        assert.ok(
          capture.args.includes(expectedArg),
          `${scenario.permissionMode}: expected "${expectedArg}" in ${JSON.stringify(capture.args)}`,
        );
      }
      // The prompt stays the last positional argument, after any permission flags.
      assert.equal(capture.args[capture.args.length - 1], 'Hi');
      assert.equal(capture.permissionEnv, scenario.expectPermissionEnv);
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    if (previousArgsCapture === undefined) {
      delete process.env.OPENCODE_ARGS_CAPTURE;
    } else {
      process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode persists live output and returns safe bounded structured diagnostics', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-artifacts-'));
  const diagnosticRoot = path.join(tempRoot, 'diagnostics');
  const pathKey = findEnvKey('PATH');
  const prompt = 'PROMPT-MUST-NOT-BE-METADATA';
  const secret = 'SECRET-MUST-NOT-LEAK';
  const messages: AnyRecord[] = [];
  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await withEnvironment({
      [pathKey]: `${tempRoot}${path.delimiter}${process.env[pathKey] || ''}`,
      CLOUDCLI_OPENCODE_DIAGNOSTIC_ROOT: diagnosticRoot,
      CLOUDCLI_OPENCODE_STDERR_TAIL_BYTES: '12',
      OPENCODE_TEST_STDERR: 'prefix-1234567890',
      OPENCODE_TEST_SECRET: secret,
    }, async () => {
      const result = await opencodeRuntime.run(prompt, { cwd: tempRoot }, {
        userId: null, send(message) { messages.push(message as AnyRecord); },
      }, runtimeContext) as ProviderRuntimeResult;
      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stderrTail, 'x-1234567890');
      assert.ok(result.endedAt >= result.startedAt);
      assert.equal(typeof result.lastOutputAt, 'number');
      assert.match(result.diagnostic?.runId || '', /^[a-z0-9]+-[0-9a-f-]{36}$/);
      assert.equal(result.diagnostic?.relativePath, result.diagnostic?.runId);
      assert.equal(path.isAbsolute(result.diagnostic?.relativePath || ''), false);
      assert.equal((result.diagnostic?.relativePath || '').includes('..'), false);

      const runDirectory = path.join(diagnosticRoot, result.diagnostic!.relativePath);
      assert.match(await readFile(path.join(runDirectory, 'stdout.log'), 'utf8'), /assistant response/);
      assert.equal(await readFile(path.join(runDirectory, 'stderr.log'), 'utf8'), 'prefix-1234567890');
      const metadata = await readFile(path.join(runDirectory, 'metadata.json'), 'utf8');
      assert.equal(metadata.includes(prompt), false);
      assert.equal(metadata.includes(secret), false);
      assert.equal(metadata.includes(tempRoot), false);
      assert.equal(JSON.stringify(result.diagnostic).includes(tempRoot), false);
      const complete = messages.find((message) => message.kind === 'complete');
      assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
      assert.equal(JSON.stringify(complete).includes(prompt), false);
      assert.equal(JSON.stringify(complete).includes(secret), false);
      assert.equal(JSON.stringify(complete).includes(diagnosticRoot), false);
      assert.ok(messages.some((message) => message.kind === 'stream_delta'));
      assert.ok(messages.some((message) => message.kind === 'error' && message.content === 'prefix-1234567890'));
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode diagnostics fail open for unusable roots and unavailable cgroups', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-fail-open-'));
  const rootAsFile = path.join(tempRoot, 'not-a-directory');
  const pathKey = findEnvKey('PATH');
  try {
    await writeFile(rootAsFile, 'occupied', 'utf8');
    await createFakeOpenCodeExecutable(tempRoot);
    await withEnvironment({
      [pathKey]: `${tempRoot}${path.delimiter}${process.env[pathKey] || ''}`,
      CLOUDCLI_OPENCODE_DIAGNOSTIC_ROOT: rootAsFile,
      CLOUDCLI_CGROUP_V2_ROOT: path.join(tempRoot, 'missing-cgroup'),
    }, async () => {
      const result = await opencodeRuntime.run('still succeeds', { cwd: tempRoot }, {
        userId: null, send() {},
      }, runtimeContext) as ProviderRuntimeResult;
      assert.equal(result.exitCode, 0);
      assert.equal(result.diagnostic, undefined);
      assert.equal(result.resources, undefined);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode diagnostics ignore malformed cgroup values and retain valid scoped values', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux cgroup v2 only');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cgroup-'));
  const cgroupRoot = path.join(tempRoot, 'cgroup');
  try {
    await mkdir(cgroupRoot);
    await writeFile(path.join(cgroupRoot, 'memory.current'), 'invalid', 'utf8');
    await writeFile(path.join(cgroupRoot, 'memory.peak'), '4096', 'utf8');
    await writeFile(path.join(cgroupRoot, 'memory.events'), 'oom 2\nbad nope\n', 'utf8');
    await writeFile(path.join(cgroupRoot, 'memory.stat'), 'anon 1024\nmalformed\n', 'utf8');
    await withEnvironment({ CLOUDCLI_OPENCODE_DIAGNOSTIC_ROOT: path.join(tempRoot, 'logs'), CLOUDCLI_CGROUP_V2_ROOT: cgroupRoot }, async () => {
      const diagnostics = await createOpenCodeRunDiagnostics(Date.now());
      const result = await diagnostics.finish({ startedAt: Date.now(), endedAt: Date.now(), lastOutputAt: null, exitCode: 0, signal: null });
      assert.equal(result.resources?.start?.scope, 'container-cgroup-v2');
      assert.equal(result.resources?.start?.memoryCurrentBytes, undefined);
      assert.equal(result.resources?.start?.memoryPeakBytes, 4096);
      assert.deepEqual(result.resources?.start?.memoryEvents, { oom: 2 });
      assert.deepEqual(result.resources?.start?.memoryStat, { anon: 1024 });
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode diagnostic retention deletes only old directories below its configured root', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-retention-'));
  const diagnosticRoot = path.join(tempRoot, 'logs');
  const outside = path.join(tempRoot, 'outside');
  try {
    await mkdir(diagnosticRoot);
    await mkdir(path.join(diagnosticRoot, 'old-run'));
    await mkdir(outside);
    await writeFile(path.join(outside, 'marker'), 'safe', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await withEnvironment({ CLOUDCLI_OPENCODE_DIAGNOSTIC_ROOT: diagnosticRoot, CLOUDCLI_OPENCODE_DIAGNOSTIC_RETENTION_COUNT: '1' }, async () => {
      const diagnostics = await createOpenCodeRunDiagnostics(Date.now());
      await diagnostics.finish({ startedAt: Date.now(), endedAt: Date.now(), lastOutputAt: null, exitCode: 0, signal: null });
      for (let attempt = 0; attempt < 50 && (await readdir(diagnosticRoot)).includes('old-run'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(await readdir(diagnosticRoot), [diagnostics.runId]);
      assert.equal((await stat(path.join(outside, 'marker'))).isFile(), true);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode signal termination returns metadata and emits exactly one complete', { skip: process.platform === 'win32' }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-signal-'));
  const pathKey = findEnvKey('PATH');
  const messages: AnyRecord[] = [];
  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await withEnvironment({
      [pathKey]: `${tempRoot}${path.delimiter}${process.env[pathKey] || ''}`,
      CLOUDCLI_OPENCODE_DIAGNOSTIC_ROOT: path.join(tempRoot, 'logs'),
      OPENCODE_TEST_SIGNAL: 'SIGTERM',
    }, async () => {
      await assert.rejects(
        opencodeRuntime.run('signal', { cwd: tempRoot }, { userId: null, send(message) { messages.push(message as AnyRecord); } }, runtimeContext),
        (error: ProviderRuntimeError) => error.runtimeResult?.signal === 'SIGTERM' && error.runtimeResult.exitCode === null,
      );
      const completes = messages.filter((message) => message.kind === 'complete');
      assert.equal(completes.length, 1);
      assert.equal(completes[0].signal, 'SIGTERM');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('manual abort terminates the process without runtime duplicate complete', { skip: process.platform === 'win32' }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-abort-'));
  const pathKey = findEnvKey('PATH');
  const messages: AnyRecord[] = [];
  const sessionId = `abort-${Date.now()}`;
  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await withEnvironment({
      [pathKey]: `${tempRoot}${path.delimiter}${process.env[pathKey] || ''}`,
      CLOUDCLI_OPENCODE_DIAGNOSTIC_ROOT: path.join(tempRoot, 'logs'),
      OPENCODE_TEST_WAIT: '1',
    }, async () => {
      const run = opencodeRuntime.run('wait', { cwd: tempRoot, sessionId }, { userId: null, send(message) { messages.push(message as AnyRecord); } }, runtimeContext);
      for (let attempt = 0; attempt < 50 && getOpenCodeRuntimeDiagnostic(sessionId).state !== 'alive'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(await opencodeRuntime.abort(sessionId), true);
      await assert.rejects(run);
      assert.equal(messages.filter((message) => message.kind === 'complete').length, 0);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
