import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  readOpenCodeLatestAssistantWindowTokens,
  readOpenCodeTokenComponents,
} from '@/modules/providers/list/opencode/opencode-token-usage.provider.js';

const createMessageDatabase = (): Database.Database => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    )
  `);
  return database;
};

const insertAssistantMessage = (
  database: Database.Database,
  id: string,
  timeCreated: number,
  tokens: Record<string, unknown>,
): void => {
  database.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    .run(id, 'provider-session', timeCreated, JSON.stringify({ role: 'assistant', tokens }));
};

test('OpenCode current-window extraction skips a zero bookkeeping tail and prefers explicit total', () => {
  const database = createMessageDatabase();
  try {
    insertAssistantMessage(database, 'meaningful-response', 1, {
      total: 160_626,
      input: 2,
      output: 3,
      reasoning: 0,
      cache: { read: 5, write: 0 },
    });
    insertAssistantMessage(database, 'bookkeeping-tail', 2, {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });

    assert.equal(readOpenCodeLatestAssistantWindowTokens(database, 'provider-session'), 160_626);
  } finally {
    database.close();
  }
});

test('OpenCode current-window extraction selects the historical 160626 response before its zero tail', () => {
  const database = createMessageDatabase();
  try {
    insertAssistantMessage(database, 'historical-response', 1, {
      total: 160_626,
      input: 1_029,
      output: 365,
      reasoning: 0,
      cache: { read: 159_232, write: 0 },
    });
    insertAssistantMessage(database, 'historical-bookkeeping-tail', 2, {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });

    assert.equal(readOpenCodeLatestAssistantWindowTokens(database, 'provider-session'), 160_626);
  } finally {
    database.close();
  }
});

test('OpenCode current-window extraction falls back to non-negative token components', () => {
  const database = createMessageDatabase();
  try {
    insertAssistantMessage(database, 'component-response', 1, {
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 10, write: 2 },
    });
    insertAssistantMessage(database, 'bookkeeping-tail', 2, {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });

    assert.equal(readOpenCodeLatestAssistantWindowTokens(database, 'provider-session'), 137);
  } finally {
    database.close();
  }
});

test('OpenCode current-window extraction reports zero for genuinely empty assistant data', () => {
  const database = createMessageDatabase();
  try {
    insertAssistantMessage(database, 'empty-response', 1, {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });

    assert.equal(readOpenCodeLatestAssistantWindowTokens(database, 'provider-session'), 0);
  } finally {
    database.close();
  }
});

test('OpenCode current-window extraction omits zero when aggregate usage proves the session is non-empty', () => {
  const database = createMessageDatabase();
  try {
    insertAssistantMessage(database, 'bookkeeping-only', 1, {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });

    assert.equal(
      readOpenCodeLatestAssistantWindowTokens(database, 'provider-session', false),
      undefined,
    );
  } finally {
    database.close();
  }
});

test('OpenCode current-window extraction remains non-fatal for old schemas', () => {
  const database = new Database(':memory:');
  try {
    assert.equal(readOpenCodeLatestAssistantWindowTokens(database, 'provider-session'), undefined);
  } finally {
    database.close();
  }
});

test('OpenCode step token extraction requires every non-negative component', () => {
  assert.deepEqual(readOpenCodeTokenComponents({
    input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 },
  }), { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 });
  assert.equal(readOpenCodeTokenComponents({ input: 1, output: 2, reasoning: 3, cache: { read: 4 } }), undefined);
  assert.equal(readOpenCodeTokenComponents({ input: -1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }), undefined);
});
