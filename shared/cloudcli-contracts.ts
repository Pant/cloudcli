/** Dependency-free, browser/server-safe CloudCLI transport contracts and parsers. */

export const CLOUDCLI_PROTOCOL_VERSION = 1 as const;

export type CloudCliProtocolVersion = typeof CLOUDCLI_PROTOCOL_VERSION;
export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode';

export type ContractFailureCode =
  | 'INVALID_TYPE'
  | 'MISSING_FIELD'
  | 'INVALID_FIELD'
  | 'UNSUPPORTED_PROTOCOL_VERSION';

export type ContractParseFailure = {
  ok: false;
  error: {
    code: ContractFailureCode;
    path: string;
    message: string;
    expected?: string;
    actual?: unknown;
  };
};

export type ContractParseSuccess<T> = { ok: true; value: T };
export type ContractParseResult<T> = ContractParseSuccess<T> | ContractParseFailure;

export type ApiSuccessEnvelope<TData> = { success: true; data: TData; requestId?: string };
export type ApiErrorEnvelope = {
  success: false;
  error: { code: string; message: string; details?: unknown; retryable?: boolean };
  requestId?: string;
};

export type MessageKind =
  | 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'stream_delta' | 'stream_end'
  | 'error' | 'complete' | 'status' | 'permission_request' | 'permission_cancelled'
  | 'session_created' | 'interactive_prompt' | 'task_notification';

/** Exact provider-reported usage and completion time for one model response. */
export type ResponseMetadata = {
  inputTokens: number;
  outputTokens: number;
  timestamp: string;
};

/** Provider-neutral message; deliberately contains no provider-native identifier. */
export type NormalizedMessage = {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  seq?: number;
  generation?: number;
  role?: 'user' | 'assistant';
  content?: string;
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: unknown;
  files?: unknown;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content?: string; isError?: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  reason?: string;
  newSessionId?: string;
  status?: string;
  summary?: string;
  tokenBudget?: unknown;
  subagentTools?: unknown;
  toolUseResult?: unknown;
  sequence?: number;
  rowid?: number;
  responseMetadata?: ResponseMetadata;
  [key: string]: unknown;
};

export type SessionHistoryPayload = {
  revision: string;
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};
export type SessionHistoryEnvelope = ApiSuccessEnvelope<SessionHistoryPayload> & {
  protocolVersion: CloudCliProtocolVersion;
};
export type SessionHistoryEnvelopeStructure = Omit<SessionHistoryEnvelope, 'data'> & {
  data: Omit<SessionHistoryPayload, 'messages'> & { messages: unknown[] };
};
export type SessionHistoryMessageChunkFailure = ContractParseFailure & { messageIndex: number };
export type SessionHistoryMessageChunkResult =
  | ContractParseSuccess<NormalizedMessage[]>
  | SessionHistoryMessageChunkFailure;

export type SessionStartMutationResult = {
  sessionId: string;
  provider: LLMProvider;
  generation: number;
  clientMutationId?: string;
};
export type SessionRenameMutationResult = {
  sessionId: string;
  summary: string;
  revision: string;
  clientMutationId?: string;
};
export type SessionRevisionConflictDetails = {
  currentRevision: string;
  session: Record<string, unknown>;
};

export type SessionLifecycleStatus =
  | 'running' | 'stalled' | 'recovering' | 'failed' | 'exited'
  | 'manually_stopped' | 'recovery_exhausted';
export type SessionRunTerminalReason =
  | 'completed' | 'manual_stop' | 'provider_error' | 'process_exited' | 'stalled' | 'recovery_exhausted';
export type SessionLifecycleContext = {
  sessionId: string;
  provider: LLMProvider;
  parentSessionId?: string | null;
  session: {
    id: string; provider: LLMProvider; model: string | null; agent: string | null;
    summary: string; lastActivity: string;
  };
  project: {
    projectId: string; path: string; fullPath: string; displayName: string; isStarred: boolean;
  } | null;
};
export type SessionLifecycleSnapshot = SessionLifecycleContext & {
  status: SessionLifecycleStatus;
  statusText: string | null;
  lastActivityAt: number;
  restartable: boolean;
  canInterrupt: boolean;
  terminalReason: SessionRunTerminalReason | null;
  exitCode: number | null;
  signal?: string | null;
  ancestors?: SessionLifecycleContext[];
};
export type RunningSessionSnapshot = SessionLifecycleContext & {
  startedAt?: number | string;
  status?: 'running' | string;
  statusText?: string | null;
  canInterrupt?: boolean;
  lastSeq?: number;
  ancestors?: SessionLifecycleContext[];
};

export type ChatSubscriptionCursor = { sessionId: string; generation?: number; lastSeq?: number };
export type ChatSubscribeCommand = {
  type: 'chat.subscribe';
  protocolVersion: CloudCliProtocolVersion;
  sessions: ChatSubscriptionCursor[];
};
export type ChatSubscribedEvent = {
  kind: 'chat_subscribed';
  protocolVersion: CloudCliProtocolVersion;
  sessionId: string;
  historyRevision: string | null;
  generation: number | null;
  isProcessing: boolean;
  lastSeq: number;
  replayFromSeq: number | null;
  replayToSeq: number | null;
  replayGap: boolean;
  refreshRequired: boolean;
  pendingPermissions: unknown[];
  timestamp: string;
};
export type SequencedChatEvent = NormalizedMessage & {
  protocolVersion: CloudCliProtocolVersion;
  generation: number;
  seq: number;
};

const providers = new Set<LLMProvider>(['claude', 'codex', 'cursor', 'opencode']);
const messageKinds = new Set<MessageKind>([
  'text', 'tool_use', 'tool_result', 'thinking', 'stream_delta', 'stream_end', 'error',
  'complete', 'status', 'permission_request', 'permission_cancelled', 'session_created',
  'interactive_prompt', 'task_notification',
]);
const lifecycleStatuses = new Set<SessionLifecycleStatus>([
  'running', 'stalled', 'recovering', 'failed', 'exited', 'manually_stopped', 'recovery_exhausted',
]);
const terminalReasons = new Set<SessionRunTerminalReason>([
  'completed', 'manual_stop', 'provider_error', 'process_exited', 'stalled', 'recovery_exhausted',
]);

function failure(code: ContractFailureCode, path: string, message: string, expected?: string, actual?: unknown): ContractParseFailure {
  return { ok: false, error: { code, path, message, ...(expected ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) } };
}
function record(value: unknown, path: string): ContractParseResult<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ok: true, value: value as Record<string, unknown> }
    : failure('INVALID_TYPE', path, `${path} must be an object.`, 'object', value);
}
function requiredString(value: Record<string, unknown>, key: string, path: string): ContractParseFailure | null {
  if (!(key in value)) return failure('MISSING_FIELD', `${path}.${key}`, `Required field ${path}.${key} is missing.`, 'non-empty string');
  return typeof value[key] === 'string' && value[key].length > 0 ? null : failure('INVALID_FIELD', `${path}.${key}`, `${path}.${key} must be a non-empty string.`, 'non-empty string', value[key]);
}
function requiredNumber(value: Record<string, unknown>, key: string, path: string): ContractParseFailure | null {
  if (!(key in value)) return failure('MISSING_FIELD', `${path}.${key}`, `Required field ${path}.${key} is missing.`, 'finite number');
  return typeof value[key] === 'number' && Number.isFinite(value[key]) ? null : failure('INVALID_FIELD', `${path}.${key}`, `${path}.${key} must be a finite number.`, 'finite number', value[key]);
}
function requiredBoolean(value: Record<string, unknown>, key: string, path: string): ContractParseFailure | null {
  if (!(key in value)) return failure('MISSING_FIELD', `${path}.${key}`, `Required field ${path}.${key} is missing.`, 'boolean');
  return typeof value[key] === 'boolean' ? null : failure('INVALID_FIELD', `${path}.${key}`, `${path}.${key} must be a boolean.`, 'boolean', value[key]);
}
function nullableNumber(value: unknown, path: string): ContractParseFailure | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value)) ? null : failure('INVALID_FIELD', path, `${path} must be a finite number or null.`, 'number | null', value);
}
function version(value: Record<string, unknown>, path = '$'): ContractParseFailure | null {
  if (!('protocolVersion' in value)) return failure('MISSING_FIELD', `${path}.protocolVersion`, `Required field ${path}.protocolVersion is missing.`, String(CLOUDCLI_PROTOCOL_VERSION));
  return value.protocolVersion === CLOUDCLI_PROTOCOL_VERSION ? null : failure('UNSUPPORTED_PROTOCOL_VERSION', `${path}.protocolVersion`, `Unsupported CloudCLI protocol version ${String(value.protocolVersion)}.`, String(CLOUDCLI_PROTOCOL_VERSION), value.protocolVersion);
}

export function parseApiSuccessEnvelope<T>(input: unknown, parseData: (value: unknown) => ContractParseResult<T>): ContractParseResult<ApiSuccessEnvelope<T>> {
  const outer = record(input, '$'); if (!outer.ok) return outer;
  if (outer.value.success !== true) return failure('INVALID_FIELD', '$.success', '$.success must be true.', 'true', outer.value.success);
  if (!('data' in outer.value)) return failure('MISSING_FIELD', '$.data', 'Required field $.data is missing.');
  const data = parseData(outer.value.data); if (!data.ok) return data;
  if (outer.value.requestId !== undefined && typeof outer.value.requestId !== 'string') return failure('INVALID_FIELD', '$.requestId', '$.requestId must be a string.', 'string', outer.value.requestId);
  return { ok: true, value: { success: true, data: data.value, ...(outer.value.requestId ? { requestId: outer.value.requestId } : {}) } };
}

export function parseApiErrorEnvelope(input: unknown): ContractParseResult<ApiErrorEnvelope> {
  const outer = record(input, '$'); if (!outer.ok) return outer;
  if (outer.value.success !== false) return failure('INVALID_FIELD', '$.success', '$.success must be false.', 'false', outer.value.success);
  const error = record(outer.value.error, '$.error'); if (!error.ok) return error;
  const invalid = requiredString(error.value, 'code', '$.error') ?? requiredString(error.value, 'message', '$.error'); if (invalid) return invalid;
  if (error.value.retryable !== undefined && typeof error.value.retryable !== 'boolean') return failure('INVALID_FIELD', '$.error.retryable', '$.error.retryable must be a boolean.', 'boolean', error.value.retryable);
  if (outer.value.requestId !== undefined && typeof outer.value.requestId !== 'string') return failure('INVALID_FIELD', '$.requestId', '$.requestId must be a string.', 'string', outer.value.requestId);
  return { ok: true, value: input as ApiErrorEnvelope };
}

export function parseNormalizedMessage(input: unknown, path = '$'): ContractParseResult<NormalizedMessage> {
  return parseNormalizedMessageAt(input, path);
}

function parseNormalizedMessageAt(input: unknown, path: string | number): ContractParseResult<NormalizedMessage> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    const resolvedPath = typeof path === 'number' ? `$.data.messages[${path}]` : path;
    return failure('INVALID_TYPE', resolvedPath, `${resolvedPath} must be an object.`, 'object', input);
  }
  const value = input as Record<string, unknown>;
  for (const key of ['id', 'sessionId', 'timestamp', 'provider', 'kind'] as const) {
    if (!(key in value)) {
      const fieldPath = `${typeof path === 'number' ? `$.data.messages[${path}]` : path}.${key}`;
      return failure('MISSING_FIELD', fieldPath, `Required field ${fieldPath} is missing.`, 'non-empty string');
    }
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      const fieldPath = `${typeof path === 'number' ? `$.data.messages[${path}]` : path}.${key}`;
      return failure('INVALID_FIELD', fieldPath, `${fieldPath} must be a non-empty string.`, 'non-empty string', value[key]);
    }
  }
  if (!providers.has(value.provider as LLMProvider)) {
    const fieldPath = `${typeof path === 'number' ? `$.data.messages[${path}]` : path}.provider`;
    return failure('INVALID_FIELD', fieldPath, `${fieldPath} is unsupported.`, 'CloudCLI provider', value.provider);
  }
  if (!messageKinds.has(value.kind as MessageKind)) {
    const fieldPath = `${typeof path === 'number' ? `$.data.messages[${path}]` : path}.kind`;
    return failure('INVALID_FIELD', fieldPath, `${fieldPath} is unsupported.`, 'normalized message kind', value.kind);
  }
  for (const key of ['seq', 'generation'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
      const fieldPath = `${typeof path === 'number' ? `$.data.messages[${path}]` : path}.${key}`;
      return failure('INVALID_FIELD', fieldPath, `${fieldPath} must be a finite number.`, 'finite number', value[key]);
    }
  }
  return { ok: true, value: input as NormalizedMessage };
}

function parseHistoryPayloadStructure(input: unknown): ContractParseResult<Omit<SessionHistoryPayload, 'messages'> & { messages: unknown[] }> {
  const parsed = record(input, '$.data'); if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!Array.isArray(value.messages)) return failure('INVALID_FIELD', '$.data.messages', '$.data.messages must be an array.', 'array', value.messages);
  const invalid = requiredString(value, 'revision', '$.data') ?? requiredNumber(value, 'total', '$.data') ?? requiredBoolean(value, 'hasMore', '$.data') ?? requiredNumber(value, 'offset', '$.data'); if (invalid) return invalid;
  if (!('limit' in value)) return failure('MISSING_FIELD', '$.data.limit', 'Required field $.data.limit is missing.', 'number | null');
  const invalidLimit = nullableNumber(value.limit, '$.data.limit'); if (invalidLimit) return invalidLimit;
  return { ok: true, value: { revision: value.revision as string, messages: value.messages, total: value.total as number, hasMore: value.hasMore as boolean, offset: value.offset as number, limit: value.limit as number | null, ...('tokenUsage' in value ? { tokenUsage: value.tokenUsage } : {}) } };
}

export function parseSessionHistoryEnvelopeStructure(input: unknown): ContractParseResult<SessionHistoryEnvelopeStructure> {
  const outer = record(input, '$'); if (!outer.ok) return outer;
  const invalidVersion = version(outer.value); if (invalidVersion) return invalidVersion;
  const parsed = parseApiSuccessEnvelope(input, parseHistoryPayloadStructure); if (!parsed.ok) return parsed;
  return { ok: true, value: { ...parsed.value, protocolVersion: CLOUDCLI_PROTOCOL_VERSION } };
}

export function validateSessionHistoryMessageChunk(messages: readonly unknown[], startIndex = 0): SessionHistoryMessageChunkResult {
  for (let index = 0; index < messages.length; index += 1) {
    const messageIndex = startIndex + index;
    const message = parseNormalizedMessageAt(messages[index], messageIndex);
    if (!message.ok) return { ...message, messageIndex };
  }
  return { ok: true, value: messages as NormalizedMessage[] };
}

export function parseSessionHistoryEnvelope(input: unknown): ContractParseResult<SessionHistoryEnvelope> {
  const outer = record(input, '$'); if (!outer.ok) return outer;
  const invalidVersion = version(outer.value); if (invalidVersion) return invalidVersion;
  if (outer.value.success !== true) return failure('INVALID_FIELD', '$.success', '$.success must be true.', 'true', outer.value.success);
  if (!('data' in outer.value)) return failure('MISSING_FIELD', '$.data', 'Required field $.data is missing.');
  const data = record(outer.value.data, '$.data'); if (!data.ok) return data;
  if (!Array.isArray(data.value.messages)) return failure('INVALID_FIELD', '$.data.messages', '$.data.messages must be an array.', 'array', data.value.messages);
  const messages = validateSessionHistoryMessageChunk(data.value.messages); if (!messages.ok) return messages;
  const invalid = requiredString(data.value, 'revision', '$.data') ?? requiredNumber(data.value, 'total', '$.data')
    ?? requiredBoolean(data.value, 'hasMore', '$.data') ?? requiredNumber(data.value, 'offset', '$.data');
  if (invalid) return invalid;
  if (!('limit' in data.value)) return failure('MISSING_FIELD', '$.data.limit', 'Required field $.data.limit is missing.', 'number | null');
  const invalidLimit = nullableNumber(data.value.limit, '$.data.limit'); if (invalidLimit) return invalidLimit;
  if (outer.value.requestId !== undefined && typeof outer.value.requestId !== 'string') return failure('INVALID_FIELD', '$.requestId', '$.requestId must be a string.', 'string', outer.value.requestId);
  return {
    ok: true,
    value: {
      success: true,
      protocolVersion: CLOUDCLI_PROTOCOL_VERSION,
      ...(outer.value.requestId ? { requestId: outer.value.requestId } : {}),
      data: {
        revision: data.value.revision as string,
        messages: messages.value,
        total: data.value.total as number,
        hasMore: data.value.hasMore as boolean,
        offset: data.value.offset as number,
        limit: data.value.limit as number | null,
        ...('tokenUsage' in data.value ? { tokenUsage: data.value.tokenUsage } : {}),
      },
    },
  };
}

export function parseSessionStartMutationResult(input: unknown): ContractParseResult<SessionStartMutationResult> {
  const parsed = record(input, '$.data'); if (!parsed.ok) return parsed;
  const invalid = requiredString(parsed.value, 'sessionId', '$.data') ?? requiredString(parsed.value, 'provider', '$.data') ?? requiredNumber(parsed.value, 'generation', '$.data');
  if (invalid) return invalid;
  if (!providers.has(parsed.value.provider as LLMProvider)) return failure('INVALID_FIELD', '$.data.provider', '$.data.provider is unsupported.', 'CloudCLI provider', parsed.value.provider);
  if (parsed.value.clientMutationId !== undefined && typeof parsed.value.clientMutationId !== 'string') return failure('INVALID_FIELD', '$.data.clientMutationId', '$.data.clientMutationId must be a string.', 'string', parsed.value.clientMutationId);
  return { ok: true, value: input as SessionStartMutationResult };
}

export function parseSessionRenameMutationResult(input: unknown): ContractParseResult<SessionRenameMutationResult> {
  const parsed = record(input, '$.data'); if (!parsed.ok) return parsed;
  const invalid = requiredString(parsed.value, 'sessionId', '$.data') ?? requiredString(parsed.value, 'summary', '$.data') ?? requiredString(parsed.value, 'revision', '$.data');
  if (invalid) return invalid;
  if (parsed.value.clientMutationId !== undefined && typeof parsed.value.clientMutationId !== 'string') return failure('INVALID_FIELD', '$.data.clientMutationId', '$.data.clientMutationId must be a string.', 'string', parsed.value.clientMutationId);
  return { ok: true, value: input as SessionRenameMutationResult };
}

function parseLifecycleContext(input: unknown, path: string): ContractParseResult<SessionLifecycleContext> {
  const parsed = record(input, path); if (!parsed.ok) return parsed; const value = parsed.value;
  const invalid = requiredString(value, 'sessionId', path) ?? requiredString(value, 'provider', path); if (invalid) return invalid;
  if (!providers.has(value.provider as LLMProvider)) return failure('INVALID_FIELD', `${path}.provider`, `${path}.provider is unsupported.`, 'CloudCLI provider', value.provider);
  const session = record(value.session, `${path}.session`); if (!session.ok) return session;
  for (const key of ['id', 'provider', 'lastActivity']) { const bad = requiredString(session.value, key, `${path}.session`); if (bad) return bad; }
  // A newly-created session legitimately has no title until its first prompt.
  if (typeof session.value.summary !== 'string') return failure('INVALID_FIELD', `${path}.session.summary`, `${path}.session.summary must be a string.`, 'string', session.value.summary);
  for (const key of ['model', 'agent']) if (!(key in session.value) || (session.value[key] !== null && typeof session.value[key] !== 'string')) return failure('INVALID_FIELD', `${path}.session.${key}`, `${path}.session.${key} must be a string or null.`, 'string | null', session.value[key]);
  if (value.project !== null) {
    const project = record(value.project, `${path}.project`); if (!project.ok) return project;
    for (const key of ['projectId', 'path', 'fullPath', 'displayName']) { const bad = requiredString(project.value, key, `${path}.project`); if (bad) return bad; }
    const bad = requiredBoolean(project.value, 'isStarred', `${path}.project`); if (bad) return bad;
  }
  return { ok: true, value: input as SessionLifecycleContext };
}

export function parseSessionLifecycleSnapshot(input: unknown): ContractParseResult<SessionLifecycleSnapshot> {
  const context = parseLifecycleContext(input, '$'); if (!context.ok) return context;
  const value = input as Record<string, unknown>;
  const invalid = requiredString(value, 'status', '$') ?? requiredNumber(value, 'lastActivityAt', '$')
    ?? requiredBoolean(value, 'restartable', '$') ?? requiredBoolean(value, 'canInterrupt', '$'); if (invalid) return invalid;
  if (!lifecycleStatuses.has(value.status as SessionLifecycleStatus)) return failure('INVALID_FIELD', '$.status', '$.status is unsupported.', 'lifecycle status', value.status);
  if (value.statusText !== null && typeof value.statusText !== 'string') return failure('INVALID_FIELD', '$.statusText', '$.statusText must be a string or null.', 'string | null', value.statusText);
  if (value.terminalReason !== null && !terminalReasons.has(value.terminalReason as SessionRunTerminalReason)) return failure('INVALID_FIELD', '$.terminalReason', '$.terminalReason is unsupported.', 'terminal reason | null', value.terminalReason);
  const exitCode = nullableNumber(value.exitCode, '$.exitCode'); if (exitCode) return exitCode;
  return { ok: true, value: input as SessionLifecycleSnapshot };
}

export function parseRunningSessionSnapshot(input: unknown): ContractParseResult<RunningSessionSnapshot> {
  const context = parseLifecycleContext(input, '$'); if (!context.ok) return context;
  const value = input as Record<string, unknown>;
  if (value.lastSeq !== undefined && requiredNumber(value, 'lastSeq', '$')) return requiredNumber(value, 'lastSeq', '$')!;
  return { ok: true, value: input as RunningSessionSnapshot };
}

export function parseChatSubscribeCommand(input: unknown): ContractParseResult<ChatSubscribeCommand> {
  const parsed = record(input, '$'); if (!parsed.ok) return parsed; const value = parsed.value;
  const invalidVersion = version(value); if (invalidVersion) return invalidVersion;
  if (value.type !== 'chat.subscribe') return failure('INVALID_FIELD', '$.type', '$.type must be chat.subscribe.', 'chat.subscribe', value.type);
  if (!Array.isArray(value.sessions)) return failure('INVALID_FIELD', '$.sessions', '$.sessions must be an array.', 'array', value.sessions);
  for (let index = 0; index < value.sessions.length; index += 1) {
    const cursor = record(value.sessions[index], `$.sessions[${index}]`); if (!cursor.ok) return cursor;
    const invalid = requiredString(cursor.value, 'sessionId', `$.sessions[${index}]`); if (invalid) return invalid;
    for (const key of ['generation', 'lastSeq'] as const) if (cursor.value[key] !== undefined && requiredNumber(cursor.value, key, `$.sessions[${index}]`)) return requiredNumber(cursor.value, key, `$.sessions[${index}]`)!;
  }
  return { ok: true, value: input as ChatSubscribeCommand };
}

export function parseChatSubscribedEvent(input: unknown): ContractParseResult<ChatSubscribedEvent> {
  const parsed = record(input, '$'); if (!parsed.ok) return parsed; const value = parsed.value;
  const invalidVersion = version(value); if (invalidVersion) return invalidVersion;
  if (value.kind !== 'chat_subscribed') return failure('INVALID_FIELD', '$.kind', '$.kind must be chat_subscribed.', 'chat_subscribed', value.kind);
  const invalid = requiredString(value, 'sessionId', '$') ?? requiredBoolean(value, 'isProcessing', '$')
    ?? requiredNumber(value, 'lastSeq', '$') ?? requiredBoolean(value, 'replayGap', '$')
    ?? requiredBoolean(value, 'refreshRequired', '$') ?? requiredString(value, 'timestamp', '$'); if (invalid) return invalid;
  for (const key of ['generation', 'replayFromSeq', 'replayToSeq'] as const) { if (!(key in value)) return failure('MISSING_FIELD', `$.${key}`, `Required field $.${key} is missing.`); const bad = nullableNumber(value[key], `$.${key}`); if (bad) return bad; }
  if (!('historyRevision' in value) || (value.historyRevision !== null && (typeof value.historyRevision !== 'string' || value.historyRevision.length === 0))) return failure('INVALID_FIELD', '$.historyRevision', '$.historyRevision must be a non-empty string or null.', 'string | null', value.historyRevision);
  if (!Array.isArray(value.pendingPermissions)) return failure('INVALID_FIELD', '$.pendingPermissions', '$.pendingPermissions must be an array.', 'array', value.pendingPermissions);
  return { ok: true, value: input as ChatSubscribedEvent };
}

export function parseSequencedChatEvent(input: unknown): ContractParseResult<SequencedChatEvent> {
  const parsed = record(input, '$'); if (!parsed.ok) return parsed;
  const invalidVersion = version(parsed.value); if (invalidVersion) return invalidVersion;
  const message = parseNormalizedMessage(input); if (!message.ok) return message;
  const invalid = requiredNumber(parsed.value, 'generation', '$') ?? requiredNumber(parsed.value, 'seq', '$'); if (invalid) return invalid;
  return { ok: true, value: input as SequencedChatEvent };
}
