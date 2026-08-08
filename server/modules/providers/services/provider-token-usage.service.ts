import fsSync, { type Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { readOpenCodeLatestAssistantWindowTokens } from '@/modules/providers/list/opencode/opencode-token-usage.provider.js';
import type { AnyRecord } from '@/shared/types.js';
import { AppError, getOpenCodeDatabasePath } from '@/shared/utils.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

type ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId: string) => SessionRow | null | undefined;
  getHomeDirectory: () => string;
  getOpenCodeDatabasePath: () => string;
  fileExists: (filePath: string) => boolean;
  readDirectory: (directoryPath: string) => Promise<Dirent[]>;
  readTextFile: (filePath: string) => Promise<string>;
  getClaudeContextWindow: () => string | undefined;
  resolveOpenCodeSessionModel: (sessionId: string) => Promise<string | undefined>;
  resolveOpenCodeContextWindow: (modelId: string | undefined) => Promise<number | undefined>;
};

type TokenUsageResult = {
  used: number;
  total?: number;
  windowTokens?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: {
    input: number;
    output: number;
  };
  unsupported?: boolean;
  message?: string;
};

type OpenCodeTokenRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

function createUnavailableOpenCodeTokenUsage(message: string): TokenUsageResult {
  return {
    used: 0,
    inputTokens: 0,
    outputTokens: 0,
    breakdown: { input: 0, output: 0 },
    unsupported: true,
    message,
  };
}

const defaultDependencies: ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  getHomeDirectory: () => os.homedir(),
  getOpenCodeDatabasePath,
  fileExists: (filePath) => fsSync.existsSync(filePath),
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  readTextFile: (filePath) => fsp.readFile(filePath, 'utf8'),
  getClaudeContextWindow: () => process.env.CONTEXT_WINDOW,
  resolveOpenCodeSessionModel: async (sessionId) => (
    await providerModelsService.resolveSessionModel('opencode', { sessionId })
  ).model,
  resolveOpenCodeContextWindow: (modelId) => providerModelsService.resolveOpenCodeContextWindow(modelId),
};

function readUsageNumber(value: unknown): number {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

function readOptionalUsageNumber(value: unknown): number | undefined {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : undefined;
}

function readCodexCurrentWindowTokens(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const usage = value as AnyRecord;
  const reportedTotal = readOptionalUsageNumber(usage.total_tokens ?? usage.totalTokens);
  if (reportedTotal !== undefined) {
    return reportedTotal;
  }

  const inputTokens = readOptionalUsageNumber(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = readOptionalUsageNumber(usage.output_tokens ?? usage.outputTokens);
  const reasoningTokens = readOptionalUsageNumber(
    usage.reasoning_output_tokens ?? usage.reasoningOutputTokens ?? usage.reasoning_tokens,
  );
  if (inputTokens === undefined && outputTokens === undefined && reasoningTokens === undefined) {
    return undefined;
  }

  return (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0);
}

function readPositiveContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

async function findCodexSessionFile(
  directoryPath: string,
  providerSessionId: string,
  dependencies: ProviderTokenUsageServiceDependencies,
): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await dependencies.readDirectory(directoryPath);
  } catch {
    // Codex session folders are date-partitioned and can disappear while a
    // cleanup is running. An unreadable branch is simply not a match.
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findCodexSessionFile(entryPath, providerSessionId, dependencies);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
      return entryPath;
    }
  }

  return null;
}

function readCodexTokenUsage(fileContent: string): TokenUsageResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let windowTokens: number | undefined;
  let contextWindow = 200_000;
  const lines = fileContent.trim().split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      const tokenInfo = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
        ? entry.payload.info
        : null;
      if (!tokenInfo) {
        continue;
      }

      if (tokenInfo.total_token_usage) {
        inputTokens = readUsageNumber(tokenInfo.total_token_usage.input_tokens);
        outputTokens = readUsageNumber(tokenInfo.total_token_usage.output_tokens);
        totalTokens = readUsageNumber(tokenInfo.total_token_usage.total_tokens)
          || inputTokens + outputTokens;
      }
      const currentWindowTokens = readCodexCurrentWindowTokens(tokenInfo.last_token_usage);
      if (currentWindowTokens !== undefined) {
        windowTokens = currentWindowTokens;
      }
      contextWindow = readUsageNumber(tokenInfo.model_context_window) || contextWindow;
      break;
    } catch {
      // A provider may be writing the last JSONL line while this read happens.
    }
  }

  return {
    used: totalTokens,
    total: contextWindow,
    ...(windowTokens === undefined ? {} : { windowTokens }),
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

function readClaudeTokenUsage(fileContent: string, configuredContextWindow: string | undefined): TokenUsageResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let latestInputTokens = 0;
  let latestOutputTokens = 0;
  let hasCurrentMessageUsage = false;
  const lines = fileContent.trim().split('\n');

  // Claude emits one assistant usage record per model call. Aggregate every
  // trustworthy record for session totals while retaining the final record as
  // the current context-window signal.
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      const usage = entry.type === 'assistant' ? entry.message?.usage : null;
      if (!usage) {
        continue;
      }

      const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
      const cacheReadTokensForMessage = readUsageNumber(
        usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
      );
      const cacheCreationTokensForMessage = readUsageNumber(
        usage.cache_creation_input_tokens
          ?? usage.cacheCreationInputTokens
          ?? usage.cacheCreationTokens,
      );
      const outputTokensForMessage = readUsageNumber(usage.output_tokens ?? usage.outputTokens);
      inputTokens += directInputTokens + cacheReadTokensForMessage + cacheCreationTokensForMessage;
      outputTokens += outputTokensForMessage;
      cacheReadTokens += cacheReadTokensForMessage;
      cacheCreationTokens += cacheCreationTokensForMessage;
      latestInputTokens = directInputTokens + cacheReadTokensForMessage + cacheCreationTokensForMessage;
      latestOutputTokens = outputTokensForMessage;
      hasCurrentMessageUsage = true;
    } catch {
      // Skip malformed lines without discarding usage from earlier messages.
    }
  }

  // Some older Claude transcripts only retain cumulative result/modelUsage.
  // Keep those counters for compatibility, but do not call them current-window
  // usage because they are not a per-message snapshot.
  if (!hasCurrentMessageUsage) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index]) as AnyRecord;
        if (entry.type !== 'result') {
          continue;
        }

        const modelUsage = entry.modelUsage && typeof entry.modelUsage === 'object'
          ? entry.modelUsage[Object.keys(entry.modelUsage)[0]]
          : null;
        const usage = entry.usage && typeof entry.usage === 'object'
          ? entry.usage
          : modelUsage;
        if (!usage || typeof usage !== 'object') {
          continue;
        }

        inputTokens = readUsageNumber(
          usage.input_tokens
            ?? usage.inputTokens
            ?? usage.cumulativeInputTokens,
        );
        cacheReadTokens = readUsageNumber(
          usage.cache_read_input_tokens
            ?? usage.cacheReadInputTokens
            ?? usage.cacheReadTokens,
        );
        cacheCreationTokens = readUsageNumber(
          usage.cache_creation_input_tokens
            ?? usage.cacheCreationInputTokens
            ?? usage.cacheCreationTokens,
        );
        inputTokens += cacheReadTokens + cacheCreationTokens;
        outputTokens = readUsageNumber(
          usage.output_tokens
            ?? usage.outputTokens
            ?? usage.cumulativeOutputTokens,
        );
        break;
      } catch {
        // Skip malformed lines while looking for an older cumulative result.
      }
    }
  }

  const parsedContextWindow = Number.parseInt(configuredContextWindow ?? '', 10);
  const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160_000;
  const cacheTokens = cacheReadTokens + cacheCreationTokens;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    ...(hasCurrentMessageUsage ? { windowTokens: latestInputTokens + latestOutputTokens } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

function readOpenCodeTokenUsage(databasePath: string, providerSessionId: string): TokenUsageResult {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = database.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = [
      'tokens_input',
      'tokens_output',
      'tokens_reasoning',
      'tokens_cache_read',
      'tokens_cache_write',
    ];

    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return createUnavailableOpenCodeTokenUsage(
        'Token usage tracking is not available in this OpenCode database schema',
      );
    }

    const row = database.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(providerSessionId) as OpenCodeTokenRow | undefined;

    if (!row) {
      return createUnavailableOpenCodeTokenUsage(
        'Token usage is unavailable because this OpenCode session is not present in provider storage',
      );
    }

    const inputTokens = readUsageNumber(row.inputTokens) + readUsageNumber(row.cacheReadTokens);
    const outputTokens = readUsageNumber(row.outputTokens);
    const used = readUsageNumber(row.inputTokens)
      + outputTokens
      + readUsageNumber(row.reasoningTokens)
      + readUsageNumber(row.cacheReadTokens)
      + readUsageNumber(row.cacheWriteTokens);
    const windowTokens = readOpenCodeLatestAssistantWindowTokens(database, providerSessionId, used === 0);

    return {
      used,
      ...(windowTokens === undefined ? {} : { windowTokens }),
      inputTokens,
      outputTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  } finally {
    database.close();
  }
}

async function attachOpenCodeContextWindow(
  usage: TokenUsageResult,
  sessionId: string,
  dependencies: ProviderTokenUsageServiceDependencies,
): Promise<TokenUsageResult> {
  if (usage.unsupported) {
    return usage;
  }

  try {
    const activeModel = await dependencies.resolveOpenCodeSessionModel(sessionId);
    const contextWindow = await dependencies.resolveOpenCodeContextWindow(activeModel);
    const positiveContextWindow = readPositiveContextWindow(contextWindow);
    return positiveContextWindow === undefined
      ? usage
      : { ...usage, total: positiveContextWindow };
  } catch {
    // Model metadata is supplemental to the existing counters. A missing or
    // failing resolver must never make the REST token-usage endpoint fail.
    return usage;
  }
}

/**
 * Creates the provider token-usage service used by the provider routes. The
 * provider test suite supplies isolated filesystem and session dependencies so
 * every calculator can be exercised without touching a developer's real data.
 */
export function createProviderTokenUsageService(
  dependencyOverrides: Partial<ProviderTokenUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return {
    /**
     * Resolves all provider-specific storage details from one app-facing
     * session id, then returns the latest usage snapshot for that provider.
     */
    async getSessionTokenUsage(sessionId: string): Promise<TokenUsageResult> {
      const session = dependencies.getSessionById(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const providerSessionId = session.provider_session_id || sessionId;

      if (session.provider === 'cursor') {
        return {
          used: 0,
          total: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Token usage tracking not available for Cursor sessions',
        };
      }

      if (session.provider === 'opencode') {
        const databasePath = dependencies.getOpenCodeDatabasePath();
        if (!dependencies.fileExists(databasePath)) {
          return createUnavailableOpenCodeTokenUsage(
            'Token usage is unavailable because the OpenCode database was not found',
          );
        }

        const usage = readOpenCodeTokenUsage(databasePath, providerSessionId);
        return attachOpenCodeContextWindow(usage, sessionId, dependencies);
      }

      if (session.provider === 'codex') {
        const indexedFilePath = session.jsonl_path && dependencies.fileExists(session.jsonl_path)
          ? session.jsonl_path
          : null;
        const sessionFilePath = indexedFilePath ?? await findCodexSessionFile(
          path.join(dependencies.getHomeDirectory(), '.codex', 'sessions'),
          providerSessionId,
          dependencies,
        );

        if (!sessionFilePath) {
          throw new AppError(`Codex session file for "${sessionId}" was not found.`, {
            code: 'CODEX_SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const fileContent = await dependencies.readTextFile(sessionFilePath);
        return readCodexTokenUsage(fileContent);
      }

      let sessionFilePath = session.jsonl_path;
      if (!sessionFilePath) {
        if (!session.project_path) {
          throw new AppError(`Session file for "${sessionId}" was not found.`, {
            code: 'SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const encodedProjectPath = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDirectory = path.join(
          dependencies.getHomeDirectory(),
          '.claude',
          'projects',
          encodedProjectPath,
        );
        sessionFilePath = path.join(projectDirectory, `${providerSessionId}.jsonl`);

        const relativePath = path.relative(path.resolve(projectDirectory), path.resolve(sessionFilePath));
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          throw new AppError('Resolved session path is invalid.', {
            code: 'INVALID_SESSION_PATH',
            statusCode: 400,
          });
        }
      }

      if (!dependencies.fileExists(sessionFilePath)) {
        throw new AppError(`Session file for "${sessionId}" was not found.`, {
          code: 'SESSION_FILE_NOT_FOUND',
          statusCode: 404,
        });
      }

      const fileContent = await dependencies.readTextFile(sessionFilePath);
      return readClaudeTokenUsage(fileContent, dependencies.getClaudeContextWindow());
    },
  };
}

/**
 * Used by the provider routes to serve token usage from only an app session id.
 */
export const providerTokenUsageService = createProviderTokenUsageService();
