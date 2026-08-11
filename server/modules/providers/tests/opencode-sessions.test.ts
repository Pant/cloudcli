import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { extractCompletedOpenCodeTask, OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { getProjectSessionsPage } from '@/modules/projects/index.js';
import { appendImagesInputTag } from '@/shared/image-attachments.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const createOpenCodeDatabase = async (homeDir: string, workspacePath: string): Promise<void> => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        vcs TEXT,
        name TEXT,
        icon_url TEXT,
        icon_color TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_initialized INTEGER,
        sandboxes TEXT NOT NULL,
        commands TEXT,
        icon_url_override TEXT
      );

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        share_url TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        summary_diffs TEXT,
        revert TEXT,
        permission TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_compacting INTEGER,
        time_archived INTEGER,
        workspace_id TEXT,
        path TEXT,
        agent TEXT,
        model TEXT,
        cost REAL NOT NULL DEFAULT 0,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning INTEGER NOT NULL DEFAULT 0,
        tokens_cache_read INTEGER NOT NULL DEFAULT 0,
        tokens_cache_write INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
      );

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
      );

      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
      );

      CREATE INDEX part_session_idx ON part (session_id);
      CREATE INDEX session_project_idx ON session (project_id);
      CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
      CREATE INDEX part_message_id_id_idx ON part (message_id, id);
    `);

    db.prepare(
      'INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'project-1',
      workspacePath,
      1_700_000_000_000,
      1_700_000_001_000,
      '[]',
    );
    db.prepare(`
      INSERT INTO session (
        id, project_id, slug, directory, title, version, time_created, time_updated, time_archived,
        agent, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'open-session-1',
      'project-1',
      'open-session-1',
      workspacePath,
      'OpenCode indexed title',
      '0.0.0',
      1_700_000_000_000,
      1_700_000_004_000,
      null,
      'Code',
      10,
      20,
      7,
      3,
      2,
    );

    const userMessageData = JSON.stringify({
      role: 'user',
      time: { created: 1_700_000_001_000 },
      agent: 'test',
      model: { providerID: 'anthropic', modelID: 'claude' },
    });
    const assistantMessageData = JSON.stringify({
      role: 'assistant',
      time: { created: 1_700_000_002_000, completed: 1_700_000_003_000 },
      parentID: 'message-user',
      modelID: 'anthropic/claude-sonnet-4-5',
      providerID: 'anthropic',
      mode: 'default',
      agent: 'test',
      path: { cwd: '.', root: '.' },
      cost: 0.01,
      tokens: {
        total: 160_626,
        input: 1_029,
        output: 365,
        reasoning: 0,
        cache: { read: 159_232, write: 0 },
      },
    });

    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    ).run('message-user', 'open-session-1', 1_700_000_001_000, 1_700_000_001_500, userMessageData);
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    ).run('message-assistant', 'open-session-1', 1_700_000_002_000, 1_700_000_003_000, assistantMessageData);
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'message-assistant-bookkeeping',
      'open-session-1',
      1_700_000_004_000,
      1_700_000_004_000,
      JSON.stringify({
        role: 'assistant',
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );

    const insertPart = db.prepare(`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertPart.run(
      'part-user-text',
      'message-user',
      'open-session-1',
      1_700_000_001_000,
      1_700_000_001_000,
      JSON.stringify({
        type: 'text',
        text: JSON.stringify('Build the OpenCode integration.'),
      }),
    );
    insertPart.run(
      'part-reasoning',
      'message-assistant',
      'open-session-1',
      1_700_000_002_000,
      1_700_000_002_000,
      JSON.stringify({
        type: 'reasoning',
        text: 'I will inspect the provider shape first.',
        time: { start: 0, end: 1 },
      }),
    );
    insertPart.run(
      'part-assistant-text',
      'message-assistant',
      'open-session-1',
      1_700_000_002_500,
      1_700_000_002_500,
      JSON.stringify({
        type: 'text',
        text: 'The provider is wired.',
      }),
    );
    insertPart.run(
      'part-tool',
      'message-assistant',
      'open-session-1',
      1_700_000_003_000,
      1_700_000_003_000,
      JSON.stringify({
        type: 'tool',
        tool: 'bash',
        callID: 'tool-call-1',
        state: {
          status: 'completed',
          input: { command: 'npm test' },
          output: 'ok',
          title: 'bash',
          metadata: {},
          time: { start: 0, end: 1 },
        },
      }),
    );
  } finally {
    db.close();
  }
};

const createNestedOpenCodeDatabase = async (
  homeDir: string,
  workspacePath: string,
  includeParentId = true,
): Promise<void> => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        ${includeParentId ? 'parent_id TEXT,' : ''}
        directory TEXT,
        title TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER,
        agent TEXT
      );
    `);
    db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('project-1', workspacePath);
    const columns = includeParentId
      ? '(id, project_id, parent_id, directory, title, time_created, time_updated, time_archived, agent)'
      : '(id, project_id, directory, title, time_created, time_updated, time_archived, agent)';
    const values = includeParentId ? 'VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)' : 'VALUES (?, ?, ?, ?, ?, ?, NULL, ?)';
    const insert = db.prepare(`INSERT INTO session ${columns} ${values}`);
    const rows = includeParentId
      ? [
        ['root-native', 'project-1', null, workspacePath, 'Root', 1_700_000_000_000, 1_700_000_003_000, 'root-agent'],
        ['child-native', 'project-1', 'root-native', workspacePath, 'Child', 1_700_000_001_000, 1_700_000_002_000, 'child-agent'],
        ['grandchild-native', 'project-1', 'child-native', workspacePath, 'Grandchild', 1_700_000_002_000, 1_700_000_004_000, 'grandchild-agent'],
      ]
      : [['root-native', 'project-1', workspacePath, 'Root', 1_700_000_000_000, 1_700_000_003_000, 'root-agent']];
    for (const row of rows) {
      insert.run(...row);
    }
  } finally {
    db.close();
  }
};

test('OpenCode session synchronizer indexes sqlite sessions without deletable transcript paths', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      const processed = synchronizer.synchronize();

      return Promise.resolve(processed).then((count) => {
        assert.equal(count, 1);
        const indexed = sessionsDb.getSessionById('open-session-1');
        assert.equal(indexed?.provider, 'opencode');
        assert.equal(indexed?.project_path, workspacePath);
        assert.equal(indexed?.custom_name, 'OpenCode indexed title');
        assert.equal(indexed?.agent, 'Code');
        assert.equal(indexed?.jsonl_path, null);
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode synchronizer indexes recursive parent relationships and returns every changed watcher row', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-nested-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createNestedOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(async () => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      assert.equal(await synchronizer.synchronize(), 3);
      assert.equal(
        await synchronizer.synchronizeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db')),
        null,
      );
      assert.equal(sessionsDb.getSessionById('child-native')?.provider_parent_session_id, 'root-native');
      assert.equal(sessionsDb.getSessionById('grandchild-native')?.provider_parent_session_id, 'child-native');
      assert.equal(sessionsDb.getCanonicalParentSessionId('child-native'), 'root-native');
      assert.equal(sessionsDb.getCanonicalParentSessionId('grandchild-native'), 'child-native');

      const db = new Database(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'));
      try {
        db.prepare('UPDATE session SET title = ?, time_updated = ? WHERE id IN (?, ?)')
          .run('Changed root', 1_700_000_010_000, 'root-native', 'child-native');
      } finally {
        db.close();
      }

      const changed = await synchronizer.synchronizeFile(
        path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'),
      );
      assert.deepEqual(new Set(Array.isArray(changed) ? changed : [changed]), new Set(['root-native', 'child-native']));
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode watcher sync rebroadcast set repairs child-before-parent ordering without historical noise', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-order-race-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createNestedOpenCodeDatabase(tempRoot, workspacePath);
    const providerDbPath = path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db');
    const providerDb = new Database(providerDbPath);
    try {
      providerDb.prepare('DELETE FROM session WHERE id IN (?, ?)').run('root-native', 'grandchild-native');
    } finally {
      providerDb.close();
    }

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession('historical-root', 'opencode', workspacePath, 'Historical root');
      const synchronizer = new OpenCodeSessionSynchronizer();
      assert.deepEqual(await synchronizer.synchronizeFile(providerDbPath), 'child-native');
      assert.equal(sessionsDb.getCanonicalParentSessionId('child-native'), undefined);

      const db = new Database(providerDbPath);
      try {
        db.prepare(`
          INSERT INTO session (
            id, project_id, parent_id, directory, title, time_created, time_updated, time_archived, agent
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `).run(
          'root-native',
          'project-1',
          null,
          workspacePath,
          'Root',
          1_700_000_000_000,
          1_700_000_005_000,
          'root-agent',
        );
      } finally {
        db.close();
      }

      const repaired = await synchronizer.synchronizeFile(providerDbPath);
      assert.deepEqual(new Set(Array.isArray(repaired) ? repaired : [repaired]), new Set([
        'root-native',
        'child-native',
      ]));
      assert.equal(sessionsDb.getCanonicalParentSessionId('child-native'), 'root-native');
      assert.equal(Array.isArray(repaired) && repaired.includes('historical-root'), false);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode hierarchy backfill hydrates canonical app parent ids from a production-shaped fixture', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-hydration-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createNestedOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-root', 'opencode', workspacePath);
      sessionsDb.createAppSession('app-child', 'opencode', workspacePath);
      sessionsDb.createAppSession('app-grandchild', 'opencode', workspacePath);
      sessionsDb.assignProviderSessionId('app-root', 'root-native');
      sessionsDb.assignProviderSessionId('app-child', 'child-native');
      sessionsDb.assignProviderSessionId('app-grandchild', 'grandchild-native');

      assert.equal(await new OpenCodeSessionSynchronizer().synchronize(), 3);

      assert.equal(sessionsDb.getSessionById('app-root')?.provider_parent_session_id, null);
      assert.equal(sessionsDb.getSessionById('app-child')?.provider_parent_session_id, 'root-native');
      assert.equal(sessionsDb.getSessionById('app-grandchild')?.provider_parent_session_id, 'child-native');

      const project = projectsDb.getProjectPath(workspacePath);
      assert.ok(project);
      const hydrated = await getProjectSessionsPage(project.project_id);
      assert.deepEqual(
        hydrated.sessions.map((session) => [session.id, session.parentSessionId]),
        [
          ['app-root', null],
          ['app-child', 'app-root'],
          ['app-grandchild', 'app-child'],
        ],
      );
      assert.equal(JSON.stringify(hydrated).includes('root-native'), false);
      assert.equal(JSON.stringify(hydrated).includes('child-native'), false);
      assert.equal(JSON.stringify(hydrated).includes('grandchild-native'), false);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode synchronizer keeps old schemas without parent_id compatible', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-no-parent-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createNestedOpenCodeDatabase(tempRoot, workspacePath, false);
    await withIsolatedDatabase(async () => {
      assert.equal(await new OpenCodeSessionSynchronizer().synchronize(), 1);
      assert.equal(sessionsDb.getSessionById('root-native')?.provider_parent_session_id, null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer returns the app session id once provider mapping exists', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-mapped-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-session-1', 'opencode', workspacePath);
      sessionsDb.assignProviderSessionId('app-session-1', 'open-session-1');

      const synchronizer = new OpenCodeSessionSynchronizer();
      return synchronizer.synchronizeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db')).then((sessionId) => {
        assert.equal(sessionId, 'app-session-1');
        assert.equal(sessionsDb.getAllSessions().length, 1);
        assert.equal(sessionsDb.getSessionById('app-session-1')?.provider_session_id, 'open-session-1');
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer adopts the pending app session before watcher sync creates a duplicate', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-race-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-session-race', 'opencode', workspacePath);

      const synchronizer = new OpenCodeSessionSynchronizer();
      return synchronizer.synchronizeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db')).then((sessionId) => {
        assert.equal(sessionId, 'app-session-race');
        assert.equal(sessionsDb.getAllSessions().length, 1);
        assert.equal(sessionsDb.getSessionById('app-session-race')?.provider_session_id, 'open-session-1');
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode sessions provider strips <images_input> from user turns and exposes attachments', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-images-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);

    // Rewrite the user text part with the tagged prompt the runtime sends.
    const taggedPrompt = appendImagesInputTag('Look at this screenshot.', [
      { path: 'C:/Users/x/.cloudcli/assets/shot.png' },
    ]);
    const db = new Database(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'));
    try {
      db.prepare('UPDATE part SET data = ? WHERE id = ?').run(
        JSON.stringify({ type: 'text', text: taggedPrompt }),
        'part-user-text',
      );
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-session-1');
    const userMessage = history.messages.find((message) => message.kind === 'text' && message.role === 'user');

    assert.equal(userMessage?.content, 'Look at this screenshot.');
    assert.deepEqual(userMessage?.images, [{ path: 'C:/Users/x/.cloudcli/assets/shot.png' }]);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode sessions provider normalizes quoted live text and skips user echoes', () => {
  const provider = new OpenCodeSessionsProvider();
  const normalized = provider.normalizeMessage({
    type: 'text',
    sessionID: 'open-session-live',
    text: JSON.stringify('hello bro'),
  }, null);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.kind, 'stream_delta');
  assert.equal(normalized[0]?.content, 'hello bro');

  const userEcho = provider.normalizeMessage({
    type: 'text',
    sessionID: 'open-session-live',
    role: 'user',
    text: 'hello bro',
  }, null);

  assert.deepEqual(userEcho, []);
});

test('OpenCode sessions provider unwraps current JSON events and canonicalizes tool calls', () => {
  const provider = new OpenCodeSessionsProvider();
  const normalized = provider.normalizeMessage({
    type: 'tool_use',
    timestamp: 1_700_000_003_000,
    sessionID: 'open-session-live',
    part: {
      id: 'part-tool-live',
      type: 'tool',
      tool: 'edit',
      callID: 'tool-call-live',
      state: {
        status: 'completed',
        input: {
          path: 'src/provider.ts',
          oldString: 'before',
          newString: 'after',
        },
        output: 'edited',
      },
    },
  }, null);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.kind, 'tool_use');
  assert.equal(normalized[0]?.toolName, 'Edit');
  assert.equal(normalized[0]?.toolId, 'tool-call-live');
  assert.deepEqual(normalized[0]?.toolInput, {
    path: 'src/provider.ts',
    oldString: 'before',
    newString: 'after',
    file_path: 'src/provider.ts',
    old_string: 'before',
    new_string: 'after',
  });
  assert.deepEqual(normalized[0]?.toolResult, { content: 'edited', isError: false });

  const text = provider.normalizeMessage({
    type: 'text',
    sessionID: 'open-session-live',
    part: { id: 'part-text-live', type: 'text', text: 'nested response' },
  }, null);
  assert.equal(text[0]?.content, 'nested response');
});

test('OpenCode sessions provider attaches exact valid step metadata and rejects malformed usage', () => {
  const provider = new OpenCodeSessionsProvider();
  const valid = provider.normalizeMessage({
    type: 'step_finish',
    timestamp: 1_700_000_003_000,
    messageID: 'message-live',
    part: {
      type: 'step-finish',
      tokens: { input: 12, output: 7, reasoning: 3, cache: { read: 20, write: 2 } },
    },
  }, 'open-session-live');
  assert.deepEqual(valid[0]?.responseMetadata, {
    inputTokens: 14,
    outputTokens: 7,
    timestamp: '2023-11-14T22:13:23.000Z',
  });

  for (const tokens of [undefined, { input: 1, output: 'bad', reasoning: 0, cache: { read: 0, write: 0 } }]) {
    const malformed = provider.normalizeMessage({ type: 'step_finish', part: { tokens } }, 'open-session-live');
    assert.equal(malformed[0]?.kind, 'stream_end');
    assert.equal(malformed[0]?.responseMetadata, undefined);
  }
});

test('OpenCode completed Task extractor accepts aliases and rejects non-success updates', () => {
  const completed = {
    type: 'tool_use',
    part: { id: 'part-task', tool: 'task', callID: 'call-task', state: { status: 'completed', input: { description: 'Review authentication' }, output: 'done' } },
  };
  assert.deepEqual(extractCompletedOpenCodeTask(completed), { taskId: 'call-task', summary: 'Review authentication' });
  assert.deepEqual(extractCompletedOpenCodeTask({ ...completed, part: { ...completed.part, tool: 'TASK' } }), { taskId: 'call-task', summary: 'Review authentication' });
  for (const status of ['running', 'error', 'cancelled']) {
    assert.equal(extractCompletedOpenCodeTask({ ...completed, part: { ...completed.part, state: { ...completed.part.state, status } } }), null);
  }
  assert.equal(extractCompletedOpenCodeTask({ ...completed, part: { ...completed.part, tool: 'bash' } }), null);
  assert.equal(extractCompletedOpenCodeTask({ ...completed, part: { ...completed.part, callID: undefined, id: undefined } }), null);
});

test('OpenCode sessions provider canonicalizes apply-patch names and preserves raw patch envelopes', () => {
  const provider = new OpenCodeSessionsProvider();
  const patchEnvelope = '*** Begin Patch\n*** Update File: src/provider.ts\n@@\n-old\n+new\n*** End Patch';
  const cases = [
    { tool: 'apply_patch', input: { patchText: patchEnvelope } },
    { tool: 'apply_patch', input: { patch: patchEnvelope } },
    { tool: 'apply-patch', input: { diff: patchEnvelope } },
    { tool: 'ApplyPatch', input: patchEnvelope },
    { tool: 'APPLYPATCH', input: JSON.stringify({ content: patchEnvelope }) },
  ];

  for (const [index, testCase] of cases.entries()) {
    const normalized = provider.normalizeMessage({
      type: 'tool_use',
      id: `patch-${index}`,
      tool: testCase.tool,
      input: testCase.input,
    }, 'open-session-live');

    assert.equal(normalized[0]?.toolName, 'ApplyPatch');
    assert.equal((normalized[0]?.toolInput as { patch?: string }).patch, patchEnvelope);
  }
});

test('OpenCode sessions provider reads sqlite history and token usage', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-session-1');

    assert.equal(history.total, 4);
    assert.equal(history.messages[0]?.kind, 'text');
    assert.equal(history.messages[0]?.role, 'user');
    assert.equal(history.messages[0]?.content, 'Build the OpenCode integration.');
    assert.equal(history.messages[1]?.kind, 'thinking');
    assert.equal(history.messages[2]?.content, 'The provider is wired.');
    assert.equal(history.messages[3]?.kind, 'tool_use');
    assert.equal(history.messages[3]?.toolName, 'Bash');
    assert.deepEqual(history.messages[3]?.toolInput, { command: 'npm test' });
    assert.deepEqual(history.messages[3]?.toolResult, { content: 'ok', isError: false });
    assert.equal(history.messages.slice(0, 3).every((message) => message.responseMetadata === undefined), true);
    assert.deepEqual(history.messages[3]?.responseMetadata, {
      inputTokens: 1_029,
      outputTokens: 365,
      timestamp: '2023-11-14T22:13:23.000Z',
    });
    assert.deepEqual(history.tokenUsage, {
      used: 42,
      windowTokens: 160_626,
      inputTokens: 13,
      outputTokens: 20,
      breakdown: {
        input: 13,
        output: 20,
      },
    });

    const paged = await provider.fetchHistory('open-session-1', { limit: 2, offset: 0 });
    assert.equal(paged.messages.length, 2);
    assert.equal(paged.hasMore, true);
    assert.equal(paged.messages[0]?.content, 'The provider is wired.');
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode history derives incremental per-call metadata without corrupting chronological predecessors', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-response-metadata-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const db = new Database(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'));
    try {
      const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
      const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
      insertMessage.run('message-second', 'open-session-1', 1_700_000_005_000, 1_700_000_006_000, JSON.stringify({
        role: 'assistant',
        time: { created: 1_700_000_005_000 },
        tokens: { total: 160_661, input: 1_020, output: 7, reasoning: 3, cache: { read: 159_631, write: 4 } },
      }));
      insertPart.run('part-second-text', 'message-second', 'open-session-1', 1_700_000_006_000, 1_700_000_006_000, JSON.stringify({ type: 'text', text: 'Second call.' }));
      insertMessage.run('message-zero', 'open-session-1', 1_700_000_006_500, 1_700_000_006_500, JSON.stringify({
        role: 'assistant', tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }));
      insertMessage.run('message-non-renderable', 'open-session-1', 1_700_000_006_700, 1_700_000_006_700, JSON.stringify({
        role: 'assistant', tokens: { total: 160_700, input: 9, output: 5, reasoning: 0, cache: { read: 159_686, write: 0 } },
      }));
      insertMessage.run('message-after-hidden', 'open-session-1', 1_700_000_006_800, 1_700_000_006_800, JSON.stringify({
        role: 'assistant', tokens: { total: 160_730, input: 10, output: 10, reasoning: 0, cache: { read: 160_710, write: 0 } },
      }));
      insertPart.run('part-after-hidden', 'message-after-hidden', 'open-session-1', 1_700_000_006_800, 1_700_000_006_800, JSON.stringify({ type: 'text', text: 'After hidden call.' }));
      insertMessage.run('message-missing-total', 'open-session-1', 1_700_000_006_900, 1_700_000_006_900, JSON.stringify({
        role: 'assistant', tokens: { input: 12, output: 6, reasoning: 0, cache: { read: 999_999, write: 3 } },
      }));
      insertPart.run('part-missing-total', 'message-missing-total', 'open-session-1', 1_700_000_006_900, 1_700_000_006_900, JSON.stringify({ type: 'text', text: 'Missing total.' }));
      insertMessage.run('message-malformed', 'open-session-1', 1_700_000_007_000, 1_700_000_007_000, JSON.stringify({
        role: 'assistant', tokens: { input: 3, output: 'bad', cache: { read: 2 } },
      }));
      insertPart.run('part-malformed-text', 'message-malformed', 'open-session-1', 1_700_000_007_000, 1_700_000_007_000, JSON.stringify({ type: 'text', text: 'Still render malformed.' }));
      insertMessage.run('message-legacy', 'open-session-1', 1_700_000_008_000, 1_700_000_008_000, JSON.stringify({ role: 'assistant' }));
      insertPart.run('part-legacy-text', 'message-legacy', 'open-session-1', 1_700_000_008_000, 1_700_000_008_000, JSON.stringify({ type: 'text', text: 'Still render legacy.' }));
      insertMessage.run('message-compacted', 'open-session-1', 1_700_000_009_000, 1_700_000_009_000, JSON.stringify({
        role: 'assistant', tokens: { total: 100, input: 8, output: 5, reasoning: 0, cache: { read: 87, write: 2 } },
      }));
      insertPart.run('part-compacted', 'message-compacted', 'open-session-1', 1_700_000_009_000, 1_700_000_009_000, JSON.stringify({ type: 'text', text: 'Compacted call.' }));
    } finally {
      db.close();
    }

    const history = await new OpenCodeSessionsProvider().fetchHistory('open-session-1');
    const second = history.messages.find((message) => message.content === 'Second call.');
    assert.deepEqual(second?.responseMetadata, {
      inputTokens: 25,
      outputTokens: 7,
      timestamp: '2023-11-14T22:13:25.000Z',
    });
    assert.deepEqual(history.messages.find((message) => message.content === 'After hidden call.')?.responseMetadata, {
      inputTokens: 20,
      outputTokens: 10,
      timestamp: '2023-11-14T22:13:26.800Z',
    });
    assert.deepEqual(history.messages.find((message) => message.content === 'Missing total.')?.responseMetadata, {
      inputTokens: 15,
      outputTokens: 6,
      timestamp: '2023-11-14T22:13:26.900Z',
    });
    assert.deepEqual(history.messages.find((message) => message.content === 'Compacted call.')?.responseMetadata, {
      inputTokens: 10,
      outputTokens: 5,
      timestamp: '2023-11-14T22:13:29.000Z',
    });
    for (const content of ['Still render malformed.', 'Still render legacy.']) {
      const message = history.messages.find((candidate) => candidate.content === content);
      assert.ok(message);
      assert.equal(message.responseMetadata, undefined);
    }
    assert.equal(history.messages.filter((message) => message.responseMetadata !== undefined).length, 5);
    assert.deepEqual(history.tokenUsage, {
      used: 42,
      windowTokens: 100,
      inputTokens: 13,
      outputTokens: 20,
      breakdown: { input: 13, output: 20 },
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('registered OpenCode history does not invoke or await model context discovery', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-history-decoupled-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const provider = new OpenCodeProvider();
    let modelDiscoveryCalls = 0;
    provider.models.getCurrentActiveModel = async () => {
      modelDiscoveryCalls += 1;
      return new Promise(() => {});
    };
    provider.models.getContextWindowForModel = async () => {
      modelDiscoveryCalls += 1;
      return new Promise(() => {});
    };

    const history = await Promise.race([
      provider.sessions.fetchHistory('open-session-1'),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('history waited for model discovery')), 250);
      }),
    ]);

    assert.equal(modelDiscoveryCalls, 0);
    assert.deepEqual(history.tokenUsage, {
      used: 42,
      windowTokens: 160_626,
      inputTokens: 13,
      outputTokens: 20,
      breakdown: { input: 13, output: 20 },
    });
    assert.equal(history.total, 4);
    assert.equal(history.messages.length, 4);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode history reports zero token usage for genuinely empty assistant data', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-history-empty-'));
  const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const db = new Database(path.join(dataDir, 'opencode.db'));

  try {
    db.exec(`
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
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      )
    `);
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)')
      .run('open-empty', 0, 0, 0, 0, 0);
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('message-empty', 'open-empty', 1, JSON.stringify({
        role: 'assistant',
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }));
  } finally {
    db.close();
  }

  try {
    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-empty');

    assert.deepEqual(history.tokenUsage, {
      used: 0,
      windowTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      breakdown: { input: 0, output: 0 },
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode history omits windowTokens for old databases without message token records', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-history-old-schema-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await seedOpenCodeSession(tempRoot, workspacePath, {
      sessionId: 'open-old-schema',
      title: 'Old schema',
      firstUserText: 'Old OpenCode database',
    });
    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-old-schema');
    assert.equal(history.tokenUsage, undefined);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Seeds a single OpenCode session with a controllable stored title and first
 * user message. Uses a minimal schema (only the columns the synchronizer reads)
 * with a plain-text user part so the derived name is unambiguous.
 */
const seedOpenCodeSession = async (
  homeDir: string,
  workspacePath: string,
  options: { sessionId: string; title: string | null; firstUserText: string },
): Promise<void> => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        directory TEXT,
        title TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);

    db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('project-1', workspacePath);
    db.prepare(`
      INSERT INTO session (id, project_id, directory, title, time_created, time_updated, time_archived)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(options.sessionId, 'project-1', workspacePath, options.title, 1_700_000_000_000, 1_700_000_001_000);
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('message-user', options.sessionId, 1_700_000_001_000, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run(
        'part-user',
        'message-user',
        options.sessionId,
        1_700_000_001_000,
        // OpenCode persists the prompt as a JSON string literal inside the text
        // field, so double-encode it here to exercise the unwrap on read.
        JSON.stringify({ type: 'text', text: JSON.stringify(options.firstUserText) }),
      );
  } finally {
    db.close();
  }
};

test('OpenCode synchronizer titles app-created sessions from the first user message', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Stored title differs from the first message so we can prove the first
    // message wins for sessions started from cloudcli.
    await seedOpenCodeSession(tempRoot, workspacePath, {
      sessionId: 'oc-app-1',
      title: 'OpenCode generated title',
      firstUserText: 'Fix the checkout crash',
    });
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'opencode', workspacePath);
      sessionsDb.assignProviderSessionId('app-1', 'oc-app-1');

      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the checkout crash');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode synchronizer keeps the stored title for indexed sessions', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-indexed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await seedOpenCodeSession(tempRoot, workspacePath, {
      sessionId: 'oc-indexed-1',
      title: 'OpenCode generated title',
      firstUserText: 'This prompt should be ignored',
    });
    await withIsolatedDatabase(async () => {
      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('oc-indexed-1')?.custom_name, 'OpenCode generated title');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
