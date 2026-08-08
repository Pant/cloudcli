import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderModels, IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  getOpenCodeDatabasePath,
  normalizeProviderTimestamp,
  readObjectRecord,
  readJsonRecord,
  readOptionalString,
  sliceTailPage,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

import { readOpenCodeLatestAssistantWindowTokens } from './opencode-token-usage.provider.js';

const PROVIDER = 'opencode';

const OPENCODE_TOOL_NAME_ALIASES: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  question: 'AskUserQuestion',
  read: 'Read',
  task: 'Task',
  todo_write: 'TodoWrite',
  'todo-write': 'TodoWrite',
  todowrite: 'TodoWrite',
  write: 'Write',
};

type OpenCodeHistoryRow = {
  message_id: string;
  message_time_created: number | null;
  message_data: string | null;
  part_id: string | null;
  part_time_created: number | null;
  part_data: string | null;
};

type OpenCodeTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const openOpenCodeDatabase = (): Database.Database | null => {
  const dbPath = getOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  return new Database(dbPath, { readonly: true, fileMustExist: true });
};

const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const normalizeOpenCodeToolName = (value: unknown): string => {
  const toolName = readOptionalString(value) ?? 'Tool';
  return OPENCODE_TOOL_NAME_ALIASES[toolName.toLowerCase()] ?? toolName;
};

const parseOpenCodeToolInput = (value: unknown): unknown => {
  if (typeof value !== 'string' || !value.trim()) {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

/**
 * Adapts OpenCode's lowercase tool names and evolving input field names to the
 * canonical shapes consumed by the shared chat tool renderers.
 */
const normalizeOpenCodeTool = (
  rawToolName: unknown,
  rawInput: unknown,
): { toolName: string; toolInput: unknown } => {
  const toolName = normalizeOpenCodeToolName(rawToolName);
  const parsedInput = parseOpenCodeToolInput(rawInput);
  const input = readObjectRecord(parsedInput);
  if (!input) {
    return { toolName, toolInput: parsedInput ?? {} };
  }

  const normalized: AnyRecord = { ...input };
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
    const filePath = input.file_path
      ?? input.filePath
      ?? input.path
      ?? input.file
      ?? input.filename;
    if (typeof filePath === 'string' && filePath.trim()) {
      normalized.file_path = filePath;
    }
  }

  if (toolName === 'Edit') {
    const oldString = input.old_string ?? input.oldString ?? input.old;
    const newString = input.new_string ?? input.newString ?? input.new;
    if (typeof oldString === 'string') {
      normalized.old_string = oldString;
    }
    if (typeof newString === 'string') {
      normalized.new_string = newString;
    }
  }

  return { toolName, toolInput: normalized };
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') {
    return unwrapJsonStringLiteral(value);
  }

  const record = readObjectRecord(value);
  const text = readOptionalString(record?.text)
    ?? readOptionalString(record?.content)
    ?? '';
  return unwrapJsonStringLiteral(text);
};

const hasUserRole = (value: unknown): boolean => {
  const record = readObjectRecord(value);
  return readOptionalString(record?.role) === 'user';
};

const isUserTextEcho = (raw: AnyRecord): boolean => {
  return readOptionalString(raw.role) === 'user'
    || hasUserRole(raw.message)
    || hasUserRole(raw.part);
};

const buildTokenUsage = (
  totals: OpenCodeTokenTotals | undefined,
  windowTokens?: number,
): AnyRecord | undefined => {
  if (!totals) {
    return undefined;
  }

  const inputTokens = totals.inputTokens;
  const displayInputTokens = inputTokens + totals.cacheReadTokens;
  const outputTokens = totals.outputTokens;
  const used = inputTokens
    + outputTokens
    + totals.reasoningTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens;

  return {
    used,
    ...(windowTokens === undefined ? {} : { windowTokens }),
    inputTokens: displayInputTokens,
    outputTokens,
    breakdown: {
      input: displayInputTokens,
      output: outputTokens,
    },
  };
};

const readPositiveContextWindow = (value: unknown): number | undefined => (
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value > 0
    ? value
    : undefined
);

const readOpenCodeSessionColumnTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const columns = db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
  if (!requiredColumns.every((column) => columnNames.has(column))) {
    return undefined;
  }

  const row = db.prepare(`
    SELECT
      tokens_input AS inputTokens,
      tokens_output AS outputTokens,
      tokens_reasoning AS reasoningTokens,
      tokens_cache_read AS cacheReadTokens,
      tokens_cache_write AS cacheWriteTokens
    FROM session
    WHERE id = ?
  `).get(sessionId) as OpenCodeTokenTotals | undefined;

  if (!row) {
    return undefined;
  }

  const totals = {
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    reasoningTokens: Number(row.reasoningTokens ?? 0),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
  };
  const used = totals.inputTokens
    + totals.outputTokens
    + totals.reasoningTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens;

  return buildTokenUsage(
    totals,
    readOpenCodeLatestAssistantWindowTokens(db, sessionId, used === 0),
  );
};

/**
 * OpenCode stores per-message token counts on assistant `message.data` objects
 * (see MessageV2.Assistant). Older DBs also had session-level counters; this
 * matches current `opencode.db` layouts that only persist message JSON.
 */
const aggregateOpenCodeSessionTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const sessionColumnUsage = readOpenCodeSessionColumnTokenUsage(db, sessionId);
  if (sessionColumnUsage) {
    return sessionColumnUsage;
  }

  let rows: { data: string }[];
  try {
    rows = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as { data: string }[];
  } catch {
    return undefined;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let hasAssistantTokenRecord = false;

  for (const row of rows) {
    const info = readJsonRecord(row.data);
    if (readOptionalString(info?.role) !== 'assistant') {
      continue;
    }

    const tokens = readObjectRecord(info?.tokens);
    if (!tokens) {
      continue;
    }
    hasAssistantTokenRecord = true;

    inputTokens += Number(tokens.input ?? 0);
    outputTokens += Number(tokens.output ?? 0);
    reasoningTokens += Number(tokens.reasoning ?? 0);
    const cache = readObjectRecord(tokens.cache);
    cacheReadTokens += Number(cache?.read ?? 0);
    cacheWriteTokens += Number(cache?.write ?? 0);
  }

  if (!hasAssistantTokenRecord) {
    return undefined;
  }

  const totals = {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
  const used = inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;

  return buildTokenUsage(
    totals,
    readOpenCodeLatestAssistantWindowTokens(db, sessionId, used === 0),
  );
};

export class OpenCodeSessionsProvider implements IProviderSessions {
  constructor(
    private readonly models?: Pick<IProviderModels, 'getCurrentActiveModel' | 'getContextWindowForModel'>,
  ) {}

  private async attachContextWindow(
    tokenUsage: AnyRecord | undefined,
    providerSessionId: string,
  ): Promise<AnyRecord | undefined> {
    if (!tokenUsage || !this.models?.getContextWindowForModel) {
      return tokenUsage;
    }

    try {
      const activeModel = await this.models.getCurrentActiveModel(providerSessionId);
      const contextWindow = readPositiveContextWindow(
        await this.models.getContextWindowForModel(activeModel.model),
      );
      return contextWindow === undefined
        ? tokenUsage
        : { ...tokenUsage, total: contextWindow };
    } catch {
      // Context metadata is supplemental; preserve history and current usage
      // when active-model or model-limit discovery is unavailable.
      return tokenUsage;
    }
  }

  /**
   * Normalizes live `opencode run --format json` events into frontend messages.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    // `opencode run --format json` wraps the actual text/reasoning/tool value
    // in `part`. Keep root-field support for older OpenCode releases.
    const part = readObjectRecord(raw.part);
    const type = readOptionalString(raw.type) ?? readOptionalString(raw.event);
    const eventSessionId = readOptionalString(raw.sessionID)
      ?? readOptionalString(raw.sessionId)
      ?? readOptionalString(part?.sessionID)
      ?? readOptionalString(part?.sessionId)
      ?? sessionId;
    const timestamp = normalizeProviderTimestamp(raw.time ?? raw.timestamp);
    const baseId = readOptionalString(raw.id)
      ?? readOptionalString(raw.messageID)
      ?? readOptionalString(part?.id)
      ?? readOptionalString(part?.messageID)
      ?? generateMessageId('opencode');

    if (type === 'text') {
      // The client already renders an optimistic user bubble, so provider user
      // echoes must not be streamed back as assistant text.
      if (isUserTextEcho(raw)) {
        return [];
      }

      const content = extractText(raw.text ?? raw.delta ?? part ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        content,
      })];
    }

    if (type === 'reasoning') {
      const content = extractText(raw.text ?? raw.delta ?? part ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        content,
      })];
    }

    if (type === 'tool_use') {
      const toolPart = part ?? raw;
      const state = readObjectRecord(toolPart.state) ?? readObjectRecord(raw.state) ?? {};
      const normalizedTool = normalizeOpenCodeTool(
        toolPart.tool ?? toolPart.name ?? raw.tool ?? raw.name,
        state.input ?? toolPart.input ?? raw.input ?? raw.arguments ?? {},
      );
      const toolId = readOptionalString(toolPart.callID)
        ?? readOptionalString(toolPart.toolCallId)
        ?? readOptionalString(raw.callID)
        ?? readOptionalString(raw.toolCallId)
        ?? baseId;
      const toolMessage = createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: normalizedTool.toolName,
        toolInput: normalizedTool.toolInput,
        toolId,
      });

      const status = readOptionalString(state.status);
      if (
        status === 'completed'
        || status === 'error'
        || raw.output !== undefined
        || raw.error !== undefined
      ) {
        toolMessage.toolResult = {
          content: formatToolContent(state.output ?? state.error ?? raw.output ?? raw.error),
          isError: status === 'error' || raw.error !== undefined,
        };
      }

      return [toolMessage];
    }

    if (type === 'error') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        content: readOptionalString(raw.error) ?? readOptionalString(raw.message) ?? 'Unknown OpenCode error',
      })];
    }

    if (type === 'step_finish') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    return [];
  }

  /**
   * Loads OpenCode history from the shared SQLite session database.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // OpenCode's shared sqlite database keys messages by the provider-native
    // session id, not the app-facing id this method is addressed with.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const db = openOpenCodeDatabase();
    if (!db) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const rows = db.prepare(`
        SELECT
          m.id AS message_id,
          m.time_created AS message_time_created,
          m.data AS message_data,
          p.id AS part_id,
          p.time_created AS part_time_created,
          p.data AS part_data
        FROM message m
        LEFT JOIN part p
          ON p.session_id = m.session_id
         AND p.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY
          COALESCE(m.time_created, 0),
          m.id,
          COALESCE(p.time_created, 0),
          p.id
      `).all(providerSessionId) as OpenCodeHistoryRow[];

      const normalized = this.normalizeHistoryRows(rows, sessionId);
      const tokenUsage = await this.attachContextWindow(
        aggregateOpenCodeSessionTokenUsage(db, providerSessionId),
        providerSessionId,
      );

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    } finally {
      db.close();
    }
  }

  private normalizeHistoryRows(rows: OpenCodeHistoryRow[], sessionId: string): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    const emittedMessageErrors = new Set<string>();

    for (const row of rows) {
      const timestamp = normalizeProviderTimestamp(row.part_time_created ?? row.message_time_created);
      const baseId = `${row.message_id}_${row.part_id ?? normalized.length}`;
      const messageInfo = readJsonRecord(row.message_data);
      const messageRole = readOptionalString(messageInfo?.role);

      if (
        messageInfo
        && messageRole === 'assistant'
        && messageInfo.error != null
        && !emittedMessageErrors.has(row.message_id)
      ) {
        emittedMessageErrors.add(row.message_id);
        normalized.push(createNormalizedMessage({
          id: `${baseId}_error`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'error',
          content: formatToolContent(messageInfo.error),
        }));
      }

      if (!row.part_id) {
        continue;
      }

      const partData = readJsonRecord(row.part_data) ?? {};
      const partType = readOptionalString(partData.type);
      if (!partType) {
        continue;
      }

      if (partType === 'text') {
        const rawContent = extractText(partData);
        // User prompts sent with attachments carry an <images_input> path
        // list; strip it for display and surface the paths as images.
        const parsedImages = messageRole === 'user'
          ? parseImagesInputTag(rawContent)
          : { text: rawContent, attachments: [] };
        const parsedFiles = messageRole === 'user'
          ? parseFilesInputTag(parsedImages.text)
          : { text: rawContent, attachments: [] };
        if (
          parsedFiles.text.trim()
          || parsedImages.attachments.length > 0
          || parsedFiles.attachments.length > 0
        ) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: messageRole === 'user' ? 'user' : 'assistant',
            content: parsedFiles.text,
            images: parsedImages.attachments.length > 0 ? parsedImages.attachments : undefined,
            files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
          }));
        }
        continue;
      }

      if (partType === 'reasoning') {
        const content = extractText(partData);
        if (content.trim()) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content,
          }));
        }
        continue;
      }

      if (partType === 'tool') {
        const state = readObjectRecord(partData.state) ?? {};
        const status = readOptionalString(state.status);
        const normalizedTool = normalizeOpenCodeTool(
          partData.tool ?? partData.name,
          state.input ?? partData.input ?? {},
        );
        const toolMessage = createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: normalizedTool.toolName,
          toolInput: normalizedTool.toolInput,
          toolId: readOptionalString(partData.callID) ?? row.part_id,
        });

        if (status === 'completed' || status === 'error') {
          toolMessage.toolResult = {
            content: formatToolContent(state.output ?? state.error),
            isError: status === 'error',
          };
        }

        normalized.push(toolMessage);
        continue;
      }

      if (partType === 'step-finish') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'stream_end',
        }));
        continue;
      }

      if (partType === 'patch' || partType === 'agent') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: partType === 'patch' ? 'Patch' : 'Agent',
          toolInput: partData,
          toolId: row.part_id,
        }));
      }
    }

    return normalized;
  }
}
