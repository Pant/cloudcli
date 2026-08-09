export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'opencode';

export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  /** Positive model context-window size, when the provider advertises one. */
  contextWindow?: number;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

export type ProviderAgentOption = {
  value: string;
  label: string;
  description?: string;
  mode: 'primary' | 'subagent' | 'all';
  model?: string;
  reasoningEffort?: string;
};

export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

export type ProviderModelsCacheInfo = {
  updatedAt: string;
  expiresAt: string;
  source: 'memory' | 'disk' | 'fresh';
};

export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'browser' | `plugin:${string}`;

export interface ProjectSession {
  id: string;
  /** Canonical app id of the immediate parent; null for roots and orphans. */
  parentSessionId?: string | null;
  /** Model recorded by the session gateway, available before composer APIs load. */
  model?: string | null;
  /** OpenCode agent recorded for this session, including subagent sessions. */
  agent?: string | null;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  provider?: LLMProvider;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  /** Number of root trees represented by the pagination domain. */
  rootTotal?: number;
  /** Root offset used to produce the current page. */
  rootOffset?: number;
  /** Next root offset; never derived from the number of returned nodes. */
  nextOffset?: number;
  [key: string]: unknown;
}

export type RunningSessionSnapshot = {
  sessionId: string;
  provider?: LLMProvider;
  parentSessionId?: string | null;
  startedAt?: number | string;
  status?: 'running' | string;
  statusText?: string | null;
  canInterrupt?: boolean;
  lastSeq?: number;
  session?: Partial<ProjectSession> & {
    id?: string;
    provider?: LLMProvider;
    model?: string | null;
    agent?: string | null;
    summary?: string;
    messageCount?: number;
    lastActivity?: string;
  } | null;
  project?: {
    projectId?: string;
    path?: string;
    fullPath?: string;
    displayName?: string;
    isStarred?: boolean;
  } | null;
  /** Inactive canonical ancestors needed to render an off-page running row. */
  ancestors?: RunningSessionAncestorSnapshot[];
};

export type SessionLifecycleStatus =
  | 'running'
  | 'recovering'
  | 'stalled'
  | 'exited'
  | 'failed'
  | 'manually_stopped'
  | 'recovery_exhausted';

export type SessionTerminalReason =
  | 'completed'
  | 'manual_stop'
  | 'provider_error'
  | 'process_exited'
  | 'stalled'
  | 'recovery_exhausted';

export type SessionLifecycleContext = RunningSessionAncestorSnapshot;

export type SessionLifecycleSnapshot = SessionLifecycleContext & {
  status: SessionLifecycleStatus;
  statusText?: string | null;
  lastActivityAt: number;
  restartable: boolean;
  canInterrupt: boolean;
  terminalReason?: SessionTerminalReason | null;
  exitCode?: number | null;
  ancestors?: SessionLifecycleContext[];
};

/**
 * Canonical, inactive context carried by a running-session snapshot. Context
 * rows hydrate project hierarchy only; they are never processing sessions and
 * therefore must not be inserted into SessionActivityMap.
 */
export type RunningSessionAncestorSnapshot = {
  sessionId: string;
  provider?: LLMProvider;
  parentSessionId?: string | null;
  session?: Partial<ProjectSession> & {
    id?: string;
    provider?: LLMProvider;
    model?: string | null;
    agent?: string | null;
    summary?: string;
    messageCount?: number;
    lastActivity?: string;
  } | null;
  project?: {
    projectId?: string;
    path?: string;
    fullPath?: string;
    displayName?: string;
    isStarred?: boolean;
  } | null;
};

// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
export interface Project {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  [key: string]: unknown;
}

export interface LoadingProgress {
  kind?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}
