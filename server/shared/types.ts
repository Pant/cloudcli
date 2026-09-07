import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

import type {
  ApiSuccessEnvelope,
  ChatSubscriptionCursor as SharedChatSubscriptionCursor,
  MessageKind as SharedMessageKind,
  NormalizedMessage as SharedNormalizedMessage,
  SessionHistoryPayload,
  SessionLifecycleContext as SharedSessionLifecycleContext,
  SessionLifecycleSnapshot as SharedSessionLifecycleSnapshot,
} from '../../shared/cloudcli-contracts.js';

export type {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  ChatSubscribeCommand,
  ChatSubscribedEvent,
  ContractParseFailure,
  ContractParseResult,
  RunningSessionSnapshot,
  SequencedChatEvent,
  SessionHistoryEnvelope,
} from '../../shared/cloudcli-contracts.js';

//----------------- HTTP RESPONSE SHAPES ------------
/**
 * Canonical success envelope used by backend APIs that return a structured payload.
 *
 * Use this for route handlers that need a stable `success/data` shape so frontend
 * consumers can parse responses consistently across endpoints.
 */
export type ApiSuccessShape<TData = unknown> = ApiSuccessEnvelope<TData>;

/**
 * Generic plain-object record used when parsing loosely typed JSON payloads.
 *
 * Use this only after runtime shape checks, not as a replacement for validated
 * domain models.
 */
export type AnyRecord = Record<string, any>;

// ---------------------------
//----------------- WEBSOCKET TRANSPORT TYPES ------------
/**
 * Minimal websocket client contract used by backend broadcaster services.
 *
 * Any transport object added to `connectedClients` must implement these two
 * members so shared services can safely send JSON strings and check whether the
 * socket is still open before broadcasting.
 */
export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
};

/** Generation-aware cursor sent by a browser when subscribing to one chat run. */
export type ChatSubscriptionCursor = SharedChatSubscriptionCursor;

/**
 * Replay metadata returned before requester-specific replay frames are delivered.
 * `replayToSeq` is the captured boundary; later live events are queued until the
 * replay finishes. `refreshRequired` directs the browser to canonical REST history.
 */
export type ChatSubscriptionSnapshot = {
  sessionId: string;
  generation: number | null;
  isProcessing: boolean;
  lastSeq: number;
  replayFromSeq: number | null;
  replayToSeq: number | null;
  replayGap: boolean;
  refreshRequired: boolean;
  events: NormalizedMessage[];
};

/**
 * Authenticated user payload attached to websocket upgrade requests.
 *
 * Platform and OSS auth flows currently use either `id` or `userId`; both are
 * represented here so websocket handlers can resolve a stable writer user id.
 */
export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

/**
 * HTTP upgrade request shape after websocket authentication succeeds.
 *
 * `verifyClient` populates `request.user` with the authenticated payload, and
 * downstream websocket handlers rely on this extended request type.
 */
export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

// ---------------------------
//----------------- PROVIDER MESSAGE MODEL ------------
/**
 * Providers supported by the unified server runtime.
 *
 * Use this as the source of truth whenever a function or payload needs to identify
 * a specific LLM integration.
 */
export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode';

// ---------------------------
//----------------- PROVIDER RUNTIME TERMINATION DIAGNOSTICS ------------
/**
 * Safe relative reference to provider-owned diagnostic artifacts.
 * The value is always a single run directory below the configured provider
 * diagnostic root and must never contain an absolute path or traversal segment.
 */
export type ProviderDiagnosticReference = {
  runId: string;
  relativePath: string;
};

/**
 * Best-effort Linux cgroup v2 measurements captured around a provider process.
 * Values describe the containing cgroup, not the individual child process, and
 * omitted fields were unavailable or malformed at collection time.
 */
export type ProviderCgroupSnapshot = {
  scope: 'container-cgroup-v2';
  capturedAt: number;
  memoryCurrentBytes?: number;
  memoryPeakBytes?: number;
  memoryEvents?: Record<string, number>;
  memoryStat?: Record<string, number>;
};

/**
 * Provider-neutral structured result returned after a runtime terminates.
 * OpenCode supplies detailed metadata; other providers may return no result.
 * Artifact references are root-relative and stderr is bounded for safe durable use.
 */
export type ProviderRuntimeResult = {
  startedAt: number;
  endedAt: number;
  lastOutputAt: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  diagnostic?: ProviderDiagnosticReference;
  stderrTail: string;
  resources?: {
    start?: ProviderCgroupSnapshot;
    end?: ProviderCgroupSnapshot;
  };
};

/** Error carrying safe structured termination evidence for failed provider runs. */
export type ProviderRuntimeError = Error & { runtimeResult?: ProviderRuntimeResult };

// ---------------------------
//----------------- DURABLE SESSION RUN LIFECYCLE ------------
/** Durable intent for the current canonical session generation. */
export type SessionRunDesiredState = 'running' | 'stopped';

/**
 * Persisted lifecycle classification for the current generation.
 * Completed history may be omitted by status APIs, while every other terminal
 * or recovery state retains enough metadata to explain or restart the run.
 */
export type SessionRunLifecycleState =
  | 'running'
  | 'stalled'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'exited'
  | 'manually_stopped'
  | 'recovery_exhausted';

/** Stable terminal categories recorded by run orchestration and recovery. */
export type SessionRunTerminalReason =
  | 'completed'
  | 'manual_stop'
  | 'provider_error'
  | 'process_exited'
  | 'stalled'
  | 'recovery_exhausted';

/**
 * Safe provider-neutral settings retained for continuing an existing session.
 * The repository sanitizes untrusted inputs into this allow-list; attachments,
 * provider-native ids, user message content, and unknown runtime values are never stored.
 */
export type SessionContinuationOptions = {
  model?: string;
  effort?: string;
  agent?: string;
  permissionMode?: string;
  projectPath?: string;
  cwd?: string;
};

/** Current durable lifecycle record exposed by the Database module barrel. */
export type SessionRunStateRecord = {
  sessionId: string;
  provider: LLMProvider;
  generation: number;
  desiredState: SessionRunDesiredState;
  lifecycleState: SessionRunLifecycleState;
  terminalReason: SessionRunTerminalReason | null;
  terminalMessage: string | null;
  exitCode: number | null;
  restartCount: number;
  continuationOptions: SessionContinuationOptions;
  startedAt: number;
  lastProgressAt: number;
  terminalAt: number | null;
  nextRecoveryAt: number | null;
  updatedAt: number;
};

/**
 * Immutable diagnostic evidence retained for one accepted canonical session generation.
 * Database consumers receive only sanitized, bounded metadata; artifact paths are relative
 * to the provider diagnostic root and resource data contains only cgroup numeric fields.
 */
export type SessionRunHistoryRecord = {
  sessionId: string;
  generation: number;
  provider: LLMProvider;
  startedAt: number;
  terminalAt: number;
  lifecycleState: Extract<SessionRunLifecycleState, 'completed' | 'failed' | 'exited' | 'recovery_exhausted'>;
  terminalReason: SessionRunTerminalReason;
  terminalMessage: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  diagnostic: ProviderDiagnosticReference | null;
  stderrTail: string;
  resources: ProviderRuntimeResult['resources'] | null;
};

/**
 * Untrusted terminal diagnostic input accepted by the Database lifecycle repository.
 * The repository generation-fences insertion against current state, ignores duplicates,
 * and defensively sanitizes every optional value before creating immutable history.
 */
export type AppendSessionRunHistoryInput = {
  sessionId: string;
  generation: number;
  provider: LLMProvider;
  startedAt: number;
  terminalAt: number;
  lifecycleState: SessionRunHistoryRecord['lifecycleState'];
  terminalReason: SessionRunTerminalReason;
  terminalMessage?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  diagnostic?: unknown;
  stderrTail?: unknown;
  resources?: unknown;
};

/** Browser-safe actionable lifecycle classifications for canonical sessions. */
export type SessionLifecycleStatus = Exclude<SessionRunLifecycleState, 'completed'>;

/**
 * Canonical session/project context attached to lifecycle status responses.
 * Provider-native identifiers are deliberately absent from this API contract.
 */
export type SessionLifecycleContext = SharedSessionLifecycleContext;

/**
 * One bounded actionable lifecycle row returned by the provider status API.
 * All ids are canonical CloudCLI ids; ancestors are inactive rendering context.
 */
export type SessionLifecycleSnapshot = SharedSessionLifecycleSnapshot & {
  /** Backend narrows browser-safe signals to Node's known signal names. */
  signal?: NodeJS.Signals | null;
};

/** Input accepted when a user send or explicit manual start creates a generation. */
export type BeginSessionRunInput = {
  sessionId: string;
  provider: LLMProvider;
  continuationOptions?: unknown;
  now?: number;
};

// ---------------------------
//----------------- PROJECT PROMPT APPOINTMENTS ------------
/** Durable scheduler trigger categories supported by project prompt appointments. */
export type AppointmentTriggerType = 'exact' | 'timer' | 'project_idle' | 'queue';

/**
 * Durable appointment lifecycle. Draft rows are inactive, scheduled rows may be
 * claimed exactly once, and `needs_review` quarantines restart-sensitive idle triggers.
 */
export type AppointmentStatus =
  | 'draft'
  | 'scheduled'
  | 'needs_review'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Snapshot of one uploaded file retained with an appointment for later revalidation. */
export type AppointmentAttachment = {
  path: string;
  name?: string;
  mimeType?: string;
  size?: number;
};

/** Provider-neutral options snapshotted when an appointment is created. */
export type AppointmentProviderOptions = {
  model?: string;
  effort?: string;
  agent?: string;
  permissionMode?: string;
  tools?: Record<string, boolean>;
};

/** Complete normalized appointment row exposed through the Database module barrel. */
export type AppointmentRecord = {
  id: string;
  projectId: string;
  sessionId: string;
  userId: string;
  provider: LLMProvider;
  prompt: string;
  options: AppointmentProviderOptions;
  attachments: AppointmentAttachment[];
  triggerType: AppointmentTriggerType;
  dueAt: number | null;
  timerDurationMs: number | null;
  projectIdleSince: number | null;
  /** Durable one-based order within the nonterminal queue for this project/user. */
  queuePosition: number | null;
  /** Durable generation returned when this appointment's detached run was launched. */
  runGeneration: number | null;
  isActive: boolean;
  status: AppointmentStatus;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  completedAt: number | null;
};

/** Input used by the Appointments service to persist a fully validated schedule. */
export type CreateAppointmentInput = {
  id: string;
  projectId: string;
  sessionId: string;
  userId: string | number;
  provider: LLMProvider;
  prompt: string;
  options?: AppointmentProviderOptions;
  attachments?: AppointmentAttachment[];
  triggerType: AppointmentTriggerType;
  dueAt?: number | null;
  timerDurationMs?: number | null;
  isActive: boolean;
  now?: number;
};

/** Conditional mutable fields accepted by appointment management workflows. */
export type UpdateAppointmentInput = {
  isActive?: boolean;
  triggerType?: AppointmentTriggerType;
  dueAt?: number | null;
  timerDurationMs?: number | null;
  status?: AppointmentStatus;
  projectIdleSince?: number | null;
  /** Queue order override used only by persistence-controlled queue mutations. */
  queuePosition?: number | null;
  /** Launched generation assigned after an appointment is atomically claimed. */
  runGeneration?: number | null;
  errorMessage?: string | null;
  now?: number;
};

/** Complete ordered mutable queue set used for one atomic project/user reorder. */
export type ReorderAppointmentQueueInput = {
  projectId: string;
  userId: string | number;
  appointmentIds: string[];
  now?: number;
};

/** Metadata retained when a generation reaches an actionable terminal state. */
export type SessionRunTerminalUpdate = {
  lifecycleState: 'completed' | 'failed' | 'exited' | 'recovery_exhausted';
  terminalReason: SessionRunTerminalReason;
  terminalMessage?: string | null;
  exitCode?: number | null;
  now?: number;
};

/**
 * One selectable model row in a provider model catalog.
 */
export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  /**
   * Positive model context-window size in tokens when the provider advertises
   * one. Providers without this metadata should omit the field.
   */
  contextWindow?: number;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

/**
 * Provider model catalog returned by `GET /api/providers/:provider/models`.
 */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

/**
 * Cache metadata returned alongside one provider model catalog.
 *
 * `updatedAt` is when the current cached snapshot was last refreshed from the
 * provider itself. `expiresAt` is the backend cache expiry timestamp, and
 * `source` tells callers whether the current response came from in-memory cache,
 * persisted disk cache, or a fresh provider fetch.
 */
export type ProviderModelsCacheInfo = {
  updatedAt: string;
  expiresAt: string;
  source: 'memory' | 'disk' | 'fresh';
};

/**
 * Full provider model lookup result returned by the backend service layer.
 *
 * Use this shape when a caller needs both the selectable model catalog and the
 * cache metadata that explains how current the catalog is.
 */
export type ProviderModelsResult = {
  models: ProviderModelsDefinition;
  cache: ProviderModelsCacheInfo;
};

// ---------------------------
//----------------- PROVIDER AGENT CONFIGURATION TYPES ------------
/**
 * One agent currently exposed by a provider runtime.
 *
 * Unlike `ProviderAgentDefinition`, this is runtime inventory rather than an
 * editable user-global config entry. It may therefore include built-in,
 * internal, user-global, and workspace-scoped agents discovered by the CLI.
 */
export type ProviderAvailableAgent = {
  name: string;
  mode: 'primary' | 'subagent' | 'all';
  description?: string;
  /** Provider-native model identifier configured on the agent, when present. */
  model?: string;
  /** Resolved provider reasoning effort configured for this runtime agent. */
  reasoningEffort?: string;
};

/**
 * Scope used when discovering the provider's live agent inventory.
 * `workspacePath` lets provider CLIs include project-local agent definitions.
 */
export type ProviderAgentListOptions = {
  workspacePath?: string;
  /** Skip a reusable catalog result while still joining an already-running refresh. */
  refresh?: boolean;
};

/**
 * Permission decision understood by OpenCode agent definitions.
 *
 * A permission can use one of these values directly, or associate ordered
 * command/tool patterns with these values for fine-grained control.
 */
export type ProviderAgentPermissionAction = 'allow' | 'ask' | 'deny';

/**
 * One OpenCode permission entry as represented in its global configuration.
 *
 * The record form preserves insertion order because OpenCode resolves matching
 * rules from first to last and lets the last matching rule win.
 */
export type ProviderAgentPermissionValue =
  | ProviderAgentPermissionAction
  | Record<string, ProviderAgentPermissionAction>;

/**
 * Normalized global OpenCode agent definition returned by the provider API.
 *
 * `options` contains provider/model-specific pass-through fields that are not
 * part of OpenCode's documented common fields. Keeping them separate on the
 * wire lets the UI edit every supported model option without allowing those
 * values to overwrite normalized fields accidentally.
 */
export type ProviderAgentDefinition = {
  name: string;
  description: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  prompt?: string;
  temperature?: number;
  topP?: number;
  steps?: number;
  disable?: boolean;
  hidden?: boolean;
  color?: string;
  permission?: Record<string, ProviderAgentPermissionValue>;
  tools?: Record<string, boolean>;
  options: Record<string, unknown>;
};

/**
 * Input used to create, update, or rename one global OpenCode agent.
 *
 * `originalName` is present only when an existing definition is being renamed.
 * Agent providers must reject a rename that would overwrite a different agent.
 */
export type UpsertProviderAgentInput = ProviderAgentDefinition & {
  originalName?: string;
};

/**
 * Partial durable preference update for one existing configurable provider agent.
 * At least one field must be supplied. `default` clears the configured reasoning
 * effort rather than storing the sentinel as a provider option.
 */
export type ProviderAgentPreferencesPatch = {
  model?: string;
  reasoningEffort?: string;
};

/**
 * Normalized preferences returned after updating one existing provider agent.
 * An omitted reasoning effort means the provider will use its default behavior.
 */
export type ProviderAgentPreferencesResult = {
  provider: LLMProvider;
  name: string;
  model?: string;
  reasoningEffort?: string;
};

// ---------------------------
//----------------- PROVIDER ACTIVE MODEL TYPES ------------
/**
 * Provider-neutral result for the model that is actively driving a session or
 * provider runtime at the time of lookup.
 *
 * `model` must always be populated. Provider adapters should use the
 * provider-specific lookup method requested by the caller, and only fall back
 * to the provider catalog `DEFAULT` value when the active model cannot be read.
 */
export type ProviderCurrentActiveModel = {
  model: string;
};

/**
 * Where a resolved session model came from.
 *
 * `session` means the app has recorded a model for this session (the user
 * picked one, or the session has been sent on at least once) and that value is
 * authoritative. `provider` means the session predates any app-recorded model
 * and the value was read back from the provider's own session state — the case
 * for sessions started directly in a provider CLI. `default` means neither was
 * available and the catalog default is standing in.
 *
 * Routes surface this so the frontend can tell a real selection apart from a
 * placeholder without re-deriving the precedence chain.
 */
export type ProviderSessionModelSource = 'session' | 'provider' | 'default';

/**
 * The model one session runs with, plus where that answer came from.
 *
 * Returned by `providerModelsService.resolveSessionModel` and used by the
 * `/models`, `/cost` and `/status` commands, the active-model route, and the
 * composer's model picker so every surface agrees on one answer.
 */
export type ProviderSessionModel = {
  provider: LLMProvider;
  sessionId: string | null;
  model: string;
  source: ProviderSessionModelSource;
};

/**
 * Message/event variants emitted by provider adapters and normalized transports.
 *
 * Keep this union in sync with event kinds produced by provider session adapters.
 */
export type MessageKind = SharedMessageKind;

/**
 * Event kinds added by the chat gateway layer on top of provider message kinds.
 *
 * These are app-level realtime events (subscription acks, sidebar deltas,
 * project loading progress, protocol failures) that are not produced by any
 * provider adapter. Together with `MessageKind` they form the complete set of
 * `kind` values a websocket client can receive, so the frontend only ever
 * needs one kind-based switch.
 */
export type GatewayEventKind =
  | 'chat_subscribed'
  | 'session_upserted'
  | 'loading_progress'
  | 'protocol_error';

/**
 * Complete set of `kind` values emitted to websocket clients.
 *
 * Every server-to-client websocket frame carries a `kind` from this union.
 * Provider runtimes emit `MessageKind` values; gateway services emit
 * `GatewayEventKind` values.
 */
export type ServerEventKind = MessageKind | GatewayEventKind;

/**
 * Provider-neutral message envelope used in REST responses and realtime channels.
 *
 * Every provider-specific message must be converted into this shape before being
 * emitted outside provider-specific modules.
 */
export type NormalizedMessage = SharedNormalizedMessage;

/**
 * Output gateway shared by WebSocket and SSE provider runs.
 *
 * Runtime adapters only depend on this structural surface, which keeps them
 * independent from the transport that ultimately delivers normalized events.
 */
export type ProviderRuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: string | number | null;
  isWebSocketWriter?: boolean;
  isSSEStreamWriter?: boolean;
};

export type ProviderPermissionDecision = {
  allow: boolean;
  updatedInput?: unknown;
  message?: string;
  rememberEntry?: unknown;
};

export type ProviderRuntimePermissionGateway = {
  resolve(requestId: string, decision: ProviderPermissionDecision): void;
  listPending(sessionId: string): unknown[];
};

/**
 * Provider-scoped application capabilities supplied to a runtime for one run.
 *
 * Keeping these lookups outside concrete SDK/CLI adapters prevents the
 * adapters from importing services that resolve back through providerRegistry.
 */
export type ProviderRuntimeContext = {
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  /**
   * Resolves an optional positive context-window maximum for the model selected
   * by this run. Providers without discoverable metadata return `undefined`;
   * runtime adapters must keep their existing usage shape in that case.
   */
  resolveContextWindow(modelId: string | null | undefined): Promise<number | undefined>;
  getProviderModels(): Promise<ProviderModelsDefinition>;
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  isProviderInstalled(): Promise<boolean>;
};

export type ProviderRunFunction = (
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
) => Promise<ProviderRuntimeResult | void | unknown>;

/**
 * Shared options used to fetch historical provider messages.
 *
 * Consumers should pass provider-specific lookup hints (`projectPath`) only
 * when the selected provider requires them.
 *
 * `providerSessionId` is the provider-native session id from the sessions
 * index (transcript file name / provider database key). Provider adapters
 * must use it — never the app-facing session id they were called with — when
 * matching transcript rows on disk, because app-created sessions use an
 * app-allocated id that the provider has never seen.
 */
export type FetchHistoryOptions = {
  projectPath?: string;
  limit?: number | null;
  offset?: number;
  providerSessionId?: string;
};

/**
 * Standardized response payload returned from provider history readers.
 *
 * Use this as the contract for APIs that return paginated conversation history.
 */
export type FetchHistoryResult = Omit<SessionHistoryPayload, 'revision'> & { revision?: string };

// ---------------------------
//----------------- PROVIDER SKILL TYPES ------------
/**
 * Scope where a provider skill definition was discovered.
 *
 * Provider skill adapters should use this to describe the origin of each
 * skill markdown file without leaking provider-specific folder names into route
 * contracts. `repo` is used for Codex repository lookup locations, while
 * `project` is used for providers that treat workspace-local skills as project
 * scoped.
 */
export type ProviderSkillScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/**
 * Shared input accepted by provider skill listing operations.
 *
 * Routes pass `workspacePath` when a caller wants project/repository skills for
 * a specific folder. Providers should fall back to the backend process cwd when
 * this option is omitted.
 */
export type ProviderSkillListOptions = {
  workspacePath?: string;
};

/**
 * One supporting file bundled with an uploaded provider skill.
 *
 * `relativePath` is resolved below the installed skill directory and must never
 * be absolute or contain traversal segments. Text files may use `utf8`; binary
 * scripts and assets should use `base64` so JSON transport does not corrupt
 * their bytes.
 */
export type ProviderSkillCreateFile = {
  relativePath: string;
  content: string;
  encoding: 'utf8' | 'base64';
};

/**
 * One skill markdown payload submitted for provider-managed installation.
 *
 * `content` is the raw markdown body that will be written to `SKILL.md`.
 * `directoryName` lets callers control the target folder name explicitly when
 * they want stable filesystem paths that differ from the markdown front matter
 * `name` field. `fileName` is optional upload metadata used only as a final
 * fallback when no directory name or front matter name is present. `files`
 * carries scripts, references, and other files from a complete skill folder.
 */
export type ProviderSkillCreateEntry = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: ProviderSkillCreateFile[];
};

/**
 * Shared input accepted by provider skill creation operations.
 *
 * The service layer batches multiple skill definitions in one request. Each
 * entry can contain only markdown or a complete skill folder.
 */
export type ProviderSkillCreateInput = {
  entries: ProviderSkillCreateEntry[];
};

export type ProviderSkillRemoveInput = {
  directoryName: string;
};

/** Scoped exact-name permission update accepted by provider skill adapters. */
export type ProviderSkillAccessUpdateInput = {
  name: string;
  enabled: boolean;
  scope: 'user' | 'project';
  workspacePath?: string;
};

/** Result of persisting one provider-native skill permission override. */
export type ProviderSkillAccessUpdateResult = {
  provider: LLMProvider;
  name: string;
  enabled: boolean;
  access: 'allow' | 'deny';
  scope: 'user' | 'project';
};

/**
 * Normalized skill record returned by provider skill adapters.
 *
 * The `command` value is the exact invocation text the selected provider expects
 * for this skill. Claude plugin skills use a namespaced command such as
 * `/plugin-name:skill-name`, while Codex skills use the `$skill-name` form.
 * `sourcePath` points to the skill markdown file that produced the record so
 * callers can distinguish duplicate skill names across scopes.
 */
export type ProviderSkill = {
  provider: LLMProvider;
  name: string;
  description: string;
  command: string;
  scope: ProviderSkillScope;
  sourcePath: string;
  /** Effective OpenCode permission for the requested global/project context. */
  enabled?: boolean;
  pluginName?: string;
  pluginId?: string;
};

/**
 * Internal source descriptor consumed by shared provider skill discovery logic.
 *
 * Concrete provider adapters build these records from their native lookup rules.
 * The shared skills provider then scans `rootDir` for child skill markdown files
 * and uses `commandForSkill` or `commandPrefix` to produce the provider-specific
 * invocation command. Set `recursive` only when a provider stores skills under
 * arbitrary nested folders below the source root.
 */
export type ProviderSkillSource = {
  scope: ProviderSkillScope;
  rootDir: string;
  recursive?: boolean;
  commandPrefix?: '/' | '$';
  commandForSkill?: (skillName: string) => string;
  pluginName?: string;
  pluginId?: string;
};

// ---------------------------
//----------------- SHARED ERROR TYPES ------------
/**
 * Optional metadata used when constructing application-level errors.
 *
 * `statusCode` should reflect the HTTP response status, while `code` identifies
 * the stable machine-readable error category.
 */
export type AppErrorOptions = {
  code?: string;
  statusCode?: number;
  details?: unknown;
};

// ---------------------------
//----------------- MCP TYPES ------------
/**
 * Scope where an MCP server definition is stored and resolved.
 *
 * `user` is global for a user account, `local` is provider-local, and `project`
 * is tied to a specific project path.
 */
export type McpScope = 'user' | 'local' | 'project';

/**
 * Transport protocol used by an MCP server definition.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Normalized MCP server model exposed to frontend and route handlers.
 *
 * Provider adapters should map provider-native config to this structure before
 * returning results. `enabled` is optional because only providers with a native
 * MCP activation state should expose it.
 */
export type ProviderMcpServer = {
  provider: LLMProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

/**
 * Payload for create/update MCP server operations.
 *
 * Routes and services should accept this type, validate it, and then persist it
 * through provider-specific MCP repositories. An omitted `enabled` value means
 * the adapter should preserve provider-native state when supported; it is not
 * equivalent to explicitly passing `false`.
 */
export type UpsertProviderMcpServerInput = {
  name: string;
  scope?: McpScope;
  transport: McpTransport;
  enabled?: boolean;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

// ---------------------------
//----------------- PROVIDER AUTH TYPES ------------
/**
 * Authentication status result returned by provider health checks.
 *
 * This shape is consumed by settings/status endpoints to report installation and
 * credential state for each provider.
 */
export type ProviderAuthStatus = {
  installed: boolean;
  provider: LLMProvider;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

// ---------------------------
//----------------- SHARED DATABASE CREDENTIAL TYPES ------------
/**
 * Safe credential view returned by credential listing APIs.
 *
 * This intentionally excludes the raw credential secret while still exposing
 * metadata needed for UI rendering and management operations.
 */
export type CredentialPublicRow = {
  id: number;
  credential_name: string;
  credential_type: string;
  description: string | null;
  created_at: string;
  is_active: number;
};

/**
 * Result returned after creating a credential record.
 *
 * Use this return shape when callers need the created id and display metadata,
 * but must never receive the stored secret value.
 */
export type CreateCredentialResult = {
  id: number | bigint;
  credentialName: string;
  credentialType: string;
};

// ---------------------------
//----------------- PROJECT PERSISTENCE TYPES ------------
/**
 * Canonical project row shape returned by the projects repository.
 *
 * Use this type whenever backend services need to pass around one database
 * project record without leaking raw SQL row typing across modules.
 */
export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
};

/**
 * Result category returned by `projectsDb.createProjectPath`.
 *
 * `created` means a fresh row was inserted, `reactivated_archived` means an
 * existing archived path was accepted and updated, and `active_conflict` means
 * an already-active path blocked project creation.
 */
export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

/**
 * Structured result returned by project-path upsert operations.
 *
 * Services should use this result to decide whether a request succeeded,
 * should return a conflict, or needs follow-up retrieval of row metadata.
 */
export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};

/**
 * Validation result for user-supplied workspace/project paths.
 *
 * `resolvedPath` is present only when validation succeeds. `error` is present
 * only when validation fails and is suitable for user-facing diagnostics.
 */
export type WorkspacePathValidationResult = {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
};

// ---------------------------
//----------------- GIT WORKTREE MANAGEMENT ------------
/**
 * Captured output of one completed `git` invocation.
 *
 * Returned by `GitCommandRunner` implementations so worktree services can read
 * both streams without caring about process plumbing.
 */
export type GitCommandResult = {
  stdout: string;
  stderr: string;
};

/**
 * Executes `git <args>` inside `cwd` and resolves with the captured output.
 *
 * All worktree services receive their git access through this contract so
 * tests can inject a fake runner instead of spawning real processes. The
 * promise must reject (with `stderr` attached when available) on a non-zero
 * exit code.
 */
export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

/**
 * One entry parsed from `git worktree list --porcelain`.
 *
 * This is the raw repository-level view (path/HEAD/branch/flags) before any
 * enrichment with project links or ahead/behind counts. `branch` is null for
 * detached-HEAD worktrees.
 */
export type WorktreePorcelainEntry = {
  path: string;
  headSha: string | null;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  isPrunable: boolean;
};

/**
 * Fully enriched worktree row served to the UI.
 *
 * Extends the porcelain entry with everything the Worktrees panel renders:
 * dirty-file count, ahead/behind relative to the base branch (the branch
 * checked out in the main worktree), last-commit metadata, and the CloudCLI
 * project row linked to the worktree directory (if one was registered).
 */
export type WorktreeDescriptor = {
  path: string;
  branch: string | null;
  headSha: string | null;
  isMain: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  isDetached: boolean;
  changedFileCount: number;
  ahead: number;
  behind: number;
  lastCommitSubject: string | null;
  lastCommitDate: string | null;
  linkedProjectId: string | null;
  linkedProjectArchived: boolean;
};

/**
 * Response payload of `GET /api/worktrees`.
 *
 * `baseBranch` is the branch checked out in the main worktree — the merge
 * target offered by the UI. `worktrees` always lists the main worktree first.
 */
export type WorktreeListResult = {
  repositoryRoot: string;
  baseBranch: string | null;
  worktrees: WorktreeDescriptor[];
};

// ---------------------------
//----------------- WORKTREE SERVICE INPUTS AND RESULTS ------------
/**
 * Input accepted by the worktree-listing workflow.
 *
 * `projectPath` may point at the main checkout or any linked worktree. The
 * service uses Git to resolve the complete repository-level worktree list.
 */
export type ListWorktreesInput = {
  projectPath: string;
};

/**
 * Input accepted when creating a linked Git worktree.
 *
 * `branch` is checked out when it already exists, otherwise it is created from
 * `baseBranch`. When `baseBranch` is omitted, the main worktree branch is used.
 */
export type CreateWorktreeInput = {
  projectPath: string;
  branch: string;
  baseBranch?: string | null;
};

/**
 * Result of successfully creating a linked Git worktree.
 *
 * `createdBranch` distinguishes a new branch from an existing branch checkout,
 * allowing API clients to accurately describe what Git changed.
 */
export type CreateWorktreeResult = {
  worktreePath: string;
  branch: string;
  createdBranch: boolean;
};

/**
 * Result of atomically creating and registering a worktree for project use.
 *
 * The Worktrees application service compensates the Git creation if project
 * registration fails, so routes only receive this shape after both steps pass.
 */
export type CreateAndOpenWorktreeResult = CreateWorktreeResult & {
  project: WorktreeProjectView;
};

/**
 * Input accepted when registering an existing worktree as a CloudCLI project.
 *
 * The service verifies that `worktreePath` belongs to the repository containing
 * `projectPath` before it creates or restores any project record.
 */
export type OpenWorktreeInput = {
  projectPath: string;
  worktreePath: string;
};

/**
 * Project view returned after a worktree is opened in CloudCLI.
 *
 * This deliberately mirrors the project-selection payload used by the Projects
 * module so the frontend can switch to the worktree without another lookup.
 */
export type WorktreeProjectView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
  sessions: [];
  sessionMeta: { hasMore: false; total: 0; rootTotal?: number; rootOffset?: number; nextOffset?: number };
};

/**
 * Input accepted when removing a linked Git worktree.
 *
 * `force` permits removal with local changes. `deleteBranch` requests
 * best-effort branch cleanup after the worktree directory is removed.
 */
export type RemoveWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  force?: boolean;
  deleteBranch?: boolean;
};

/**
 * Result of removing a linked Git worktree.
 *
 * `archivalError` reports best-effort project archival failure after Git has
 * already removed the worktree, allowing callers to represent partial success.
 */
export type RemoveWorktreeResult = {
  removedPath: string;
  branch: string | null;
  branchDeleted: boolean;
  archivedProjectId: string | null;
  archivalError: string | null;
};

/**
 * Input accepted when merging a linked worktree into the main worktree branch.
 *
 * The service verifies both worktrees are clean, supports squash and regular
 * merges, and may remove the source worktree after a successful merge.
 */
export type MergeWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  squash?: boolean;
  message?: string | null;
  removeAfterMerge?: boolean;
};

/**
 * Result of a completed worktree merge.
 *
 * `removedWorktree` is populated only when post-merge removal succeeds.
 * `cleanupError` reports failed optional removal without misrepresenting the
 * already-completed merge as a failure.
 */
export type MergeWorktreeResult = {
  mergedBranch: string;
  targetBranch: string;
  squash: boolean;
  removedWorktree: RemoveWorktreeResult | null;
  cleanupError: string | null;
};

// ---------------------------
//----------------- WORKTREE MODULE DEPENDENCY CONTRACTS ------------
/**
 * Filesystem capability required by the Worktrees module.
 *
 * Production wiring checks the real filesystem; unit tests provide a small
 * deterministic fake so worktree creation never touches developer directories.
 */
export type WorktreeFileSystem = {
  pathExists(candidatePath: string): Promise<boolean>;
};

/**
 * Project-management boundary consumed by Worktrees workflows.
 *
 * The Worktrees module uses this contract instead of importing Database or
 * Projects internals. Production adapters delegate through those modules'
 * `index.ts` barrels, while unit tests supply in-memory functions.
 */
export type WorktreeProjectGateway = {
  getProjectPathById(projectId: string): string | null;
  getProjectByPath(projectPath: string): ProjectRepositoryRow | null;
  createProject(input: {
    projectPath: string;
    customName: string;
  }): Promise<{
    outcome: 'created' | 'reactivated_archived';
    project: { projectId: string };
  }>;
  restoreProject(projectId: string): void | Promise<void>;
  archiveProject(projectId: string): void | Promise<void>;
};

/**
 * Complete application-service surface used by the Worktrees HTTP router.
 *
 * Routes parse transport values and call these functions; they do not import
 * repositories, filesystem adapters, Git runners, or individual service files.
 */
export type WorktreeServices = {
  resolveProjectPath(projectId: string, repository?: string): Promise<string>;
  list(input: ListWorktreesInput): Promise<WorktreeListResult>;
  create(input: CreateWorktreeInput): Promise<CreateWorktreeResult>;
  createAndOpen(input: CreateWorktreeInput): Promise<CreateAndOpenWorktreeResult>;
  open(input: OpenWorktreeInput): Promise<WorktreeProjectView>;
  merge(input: MergeWorktreeInput): Promise<MergeWorktreeResult>;
  remove(input: RemoveWorktreeInput): Promise<RemoveWorktreeResult>;
};

// ---------------------------
//----------------- FILE TREE MODULE CONTRACTS ------------
/**
 * One filesystem item returned by the File Tree API.
 *
 * The service populates metadata without following symlinks when requested and
 * recursively attaches `children` only while the requested depth permits
 * traversal. Metadata-free listings retain stable zero/null/permission
 * placeholders in the required metadata fields. The frontend uses the absolute
 * `path` as the stable identifier for editor and file-operation requests.
 */
export type FileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  permissions: string;
  permissionsRwx: string;
  isSymlink?: boolean;
  children?: FileTreeNode[];
};

/**
 * Optional controls for a project File Tree listing.
 *
 * `targetPath` is relative to the project root (an absolute path is accepted
 * only when it remains inside that root). `depth` controls recursive traversal
 * and is bounded by the shared File Tree maximum; omitted values preserve the legacy
 * project-root, depth-10 listing. Metadata is enabled by default so existing
 * complete-tree consumers retain their response shape. Gitignore matching is
 * always evaluated relative to the project root, including nested listings.
 */
export type FileTreeListOptions = {
  respectGitignore?: boolean;
  targetPath?: string;
  depth?: number;
  includeMetadata?: boolean;
};

/**
 * Controls one stable page of direct children for the explorer File Tree.
 * Offset and limit are defensively normalized by the service; recursion is
 * intentionally unavailable so page work remains bounded.
 */
export type FileTreePageOptions = {
  respectGitignore?: boolean;
  targetPath?: string;
  offset?: number;
  limit?: number;
  includeMetadata?: boolean;
};

/** Stable direct-directory page returned only by the explorer paging endpoint. */
export type FileTreePageResult = {
  items: FileTreeNode[];
  hasMore: boolean;
  nextOffset: number | null;
  total: number;
};

/**
 * Minimal directory-entry shape required during File Tree traversal.
 *
 * Production adapts Node `Dirent` objects to this structural contract. Tests
 * provide small handwritten entries and therefore never read real directories.
 */
export type FileTreeDirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};

/**
 * Minimal file-stat shape used for tree metadata and delete decisions.
 *
 * The numeric mode is converted to octal and rwx strings for the UI. `lstat`
 * supplies symlink state while `stat` is used when deciding file versus folder
 * deletion behavior.
 */
export type FileTreeStats = {
  size: number;
  mtime: Date;
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Complete filesystem capability injected into File Tree services.
 *
 * The production composition root delegates these operations to Node's fs
 * APIs. Unit tests provide deterministic path-keyed fakes so service tests
 * cannot inspect, write, rename, or delete developer files.
 */
export type FileTreeFileSystem = {
  access(candidatePath: string): Promise<void>;
  stat(candidatePath: string): Promise<FileTreeStats>;
  lstat(candidatePath: string): Promise<FileTreeStats>;
  readdir(directoryPath: string): Promise<FileTreeDirectoryEntry[]>;
  realpath(candidatePath: string): Promise<string>;
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  makeDirectory(directoryPath: string, recursive: boolean): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  removeDirectory(directoryPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  /** Recursively copies a file or directory without replacing an existing destination. */
  copyEntry(sourcePath: string, destinationPath: string): Promise<void>;
  createReadStream(filePath: string): Readable;
};

/** Batch mutation supported by the project-scoped File Tree API. */
export type FileTreeBatchOperation = 'copy' | 'move' | 'delete';

/** Validated service input for one preflighted multi-entry filesystem mutation. */
export type FileTreeBatchMutationInput = {
  projectId: string;
  operation: FileTreeBatchOperation;
  sourcePaths: string[];
  /** Required for copy/move and omitted for delete. */
  destinationPath?: string;
};

/** Completed batch mutation, including normalized sources and produced destinations. */
export type FileTreeBatchMutationResult = {
  success: true;
  operation: FileTreeBatchOperation;
  affectedPaths: string[];
  destinationPaths: string[];
  message: string;
};

/**
 * Project lookup boundary consumed by File Tree workflows.
 *
 * File Tree services resolve DB-assigned project ids through this contract and
 * never import the Database module or its repositories directly.
 */
export type FileTreeProjectGateway = {
  getProjectPathById(projectId: string): string | null | Promise<string | null>;
};

/**
 * Workspace validation boundary used by filesystem browsing and folder creation.
 *
 * The injected validator enforces the configured workspace root and resolves
 * symlinks before the File Tree service exposes or mutates paths.
 */
export type FileTreeWorkspaceGateway = {
  rootPath: string;
  validatePath(candidatePath: string): Promise<WorkspacePathValidationResult>;
};

/**
 * Uploaded-file record passed from the Multer transport adapter into the File
 * Tree service.
 *
 * Transport-specific field names are normalized so upload workflows do not
 * depend on Express or Multer types.
 */
export type FileTreeUploadedFile = {
  originalName: string;
  temporaryPath: string;
  size: number;
  mimeType: string;
};

/**
 * Logger boundary for expected File Tree diagnostics.
 *
 * Production delegates to the server console. Unit tests use no-op or captured
 * loggers and never patch the global console singleton.
 */
export type FileTreeLogger = {
  error(message: string, error?: unknown): void;
};

/**
 * Required production dependencies for the File Tree application service.
 *
 * Filesystem, project lookup, workspace policy, MIME detection, concurrency,
 * and logging are all explicit so service construction has no hidden process,
 * repository, or machine-wide defaults.
 */
export type FileTreeServiceDependencies = {
  fileSystem: FileTreeFileSystem;
  projects: FileTreeProjectGateway;
  workspace: FileTreeWorkspaceGateway;
  resolveMimeType(filePath: string): string;
  fileSystemConcurrency: number;
  logger: FileTreeLogger;
};

/**
 * Complete File Tree application-service surface consumed by HTTP routes.
 *
 * Routes parse transport inputs and call these methods; they never resolve
 * project repositories, validate filesystem ownership, or perform filesystem
 * mutations themselves.
 */
export type FileTreeServices = {
  browseWorkspace(inputPath: string | null): Promise<{
    path: string;
    suggestions: Array<{ path: string; name: string; type: 'directory' }>;
  }>;
  createWorkspaceFolder(folderPath: string): Promise<{ success: true; path: string }>;
  readTextFile(projectId: string, filePath: string): Promise<{ content: string; path: string }>;
  openFile(projectId: string, filePath: string): Promise<{ contentType: string; stream: Readable }>;
  saveTextFile(projectId: string, filePath: string, content: string): Promise<{
    success: true;
    path: string;
    message: string;
  }>;
  listProjectFiles(
    projectId: string,
    options?: FileTreeListOptions,
  ): Promise<FileTreeNode[]>;
  listProjectFilePage(
    projectId: string,
    options?: FileTreePageOptions,
  ): Promise<FileTreePageResult>;
  createEntry(input: {
    projectId: string;
    parentPath: string;
    type: 'file' | 'directory';
    name: string;
  }): Promise<{ success: true; path: string; name: string; type: 'file' | 'directory'; message: string }>;
  renameEntry(input: { projectId: string; oldPath: string; newName: string }): Promise<{
    success: true;
    oldPath: string;
    newPath: string;
    newName: string;
    message: string;
  }>;
  deleteEntry(input: { projectId: string; targetPath: string }): Promise<{
    success: true;
    path: string;
    type: 'file' | 'directory';
    message: string;
  }>;
  batchMutateEntries(input: FileTreeBatchMutationInput): Promise<FileTreeBatchMutationResult>;
  storeUploadedFiles(input: {
    projectId: string;
    targetPath: string;
    relativePaths: string[];
    requestedFileCount: number;
    files: FileTreeUploadedFile[];
  }): Promise<{
    success: true;
    files: Array<{ name: string; path: string; size: number; mimeType: string }>;
    uploadedCount: number;
    requestedFileCount: number;
    targetPath: string;
    message: string;
  }>;
};

// ---------------------------
//----------------- VOICE MODULE CONTRACTS ------------
/**
 * Per-request voice settings parsed from authenticated HTTP headers.
 *
 * The Voice routes create this value from the optional `x-voice-*` headers and
 * pass it to the Voice service. Empty values mean "use the server-configured
 * default"; the backend base URL is intentionally absent because clients must
 * never control the server's outbound destination.
 */
export type VoiceRequestOverrides = {
  apiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
};

/**
 * Uploaded audio accepted by the Voice transcription service.
 *
 * Routes translate Multer's transport-specific file object into this minimal
 * shape so the service does not depend on Express or Multer types.
 */
export type VoiceAudioUpload = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

/**
 * Successful speech payload returned by the Voice service.
 *
 * The route copies `contentType` to the client response and pipes `body`
 * without buffering the complete synthesized audio in application memory.
 */
export type VoiceSpeechPayload = {
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
};

/**
 * Explicit service result used by Voice routes instead of transport-aware
 * exceptions.
 *
 * Services return `ok: false` with the exact client status/message for expected
 * backend, validation, and timeout failures. Routes only translate the result
 * into HTTP output, while unexpected programming errors still reject normally.
 */
export type VoiceServiceResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; status: number; error: string };

/**
 * Complete application-service surface consumed by the Voice HTTP router.
 *
 * The composition root supplies a concrete implementation with environment
 * configuration and an injected outbound HTTP adapter. Unit tests use the same
 * contract with handwritten fetch fakes and never patch global state.
 */
export type VoiceService = {
  getHealth(): { configured: boolean };
  transcribe(input: {
    audio: VoiceAudioUpload;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<{ text: string }>>;
  synthesizeSpeech(input: {
    text: string;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<VoiceSpeechPayload>>;
};

// ---------------------------
//----------------- CLI MODULE CONTRACTS ------------
/**
 * Output boundary used by the CLI and Sandbox services.
 *
 * Production wiring delegates to the real console. Unit tests collect these
 * calls in arrays, which keeps command assertions deterministic and avoids
 * monkey-patching the global console singleton.
 */
export type CliOutput = {
  log(message?: string): void;
  error(message?: string): void;
};

/**
 * Minimal synchronous filesystem surface shared by CLI status reporting and
 * sandbox workspace validation.
 *
 * The production composition root adapts Node's filesystem module. Tests supply
 * path-keyed fakes, so service tests never inspect or modify the real machine.
 */
export type CliFileSystem = {
  readTextFile(filePath: string): string;
  pathExists(filePath: string): boolean;
  getFileStats(filePath: string): { size: number; modifiedAt: Date };
};

/**
 * Mutable environment view owned by the CLI application.
 *
 * CLI options update this object before the server starts. Production passes
 * `process.env`; tests pass a plain record to verify option precedence without
 * changing process-wide environment state.
 */
export type CliEnvironment = Record<string, string | undefined>;

/**
 * Package metadata displayed by CLI help, status, version, and update commands.
 *
 * The composition root reads this once from the application package file and
 * injects only the fields the service needs.
 */
export type CliPackageMetadata = {
  version: string;
  homepage?: string;
  bugsUrl?: string;
};

/**
 * Executable CLI application returned by the CLI composition root.
 *
 * The thin executable entrypoint passes `process.argv` arguments to `run` and
 * copies the returned code to `process.exitCode`. Tests invoke the same method
 * directly with isolated dependencies.
 */
export type CliApplication = {
  run(argumentsList: string[]): Promise<number>;
};

/**
 * Sandbox command service consumed by the top-level CLI command dispatcher.
 *
 * Keeping this behind one required dependency lets CLI tests use a tiny fake,
 * while focused Sandbox tests exercise subprocess and filesystem behavior with
 * their own handwritten adapters.
 */
export type SandboxCommandService = {
  execute(argumentsList: string[]): Promise<number>;
};
