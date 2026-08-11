import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { ResponseMetadata } from '../../../../shared/cloudcli-contracts';
import type {
  MarkSessionIdle,
  MarkSessionProcessing,
  SessionActivityMap,
} from '../../../hooks/useSessionProtection';

export type Provider = LLMProvider;
export type ChatResponseMetadata = ResponseMetadata;

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';

export interface ChatAttachment {
  /** Absolute path inside the server-managed chat attachment store. */
  path?: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface ChatImage extends ChatAttachment {
  /** Inline data URL (Claude history stores image attachments as base64). */
  data?: string;
}

export interface ToolResult {
  content?: unknown;
  isError?: boolean;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  [key: string]: unknown;
}

export interface SubagentChildTool {
  toolId: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResult | null;
  timestamp: Date;
}

export interface ChatMessage {
  /** Stable normalized row identity retained across cache/REST/realtime sources. */
  id?: string;
  sessionId?: string;
  generation?: number;
  seq?: number;
  sourceKind?: string;
  provider?: Provider;
  responseMetadata?: ChatResponseMetadata;
  renderKeySuffix?: string;
  type: string;
  content?: string;
  displayText?: string;
  timestamp: string | number | Date;
  images?: ChatImage[];
  files?: ChatAttachment[];
  reasoning?: string;
  isThinking?: boolean;
  isStreaming?: boolean;
  isInteractivePrompt?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  toolId?: string;
  toolCallId?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  isSubagentContainer?: boolean;
  subagentState?: {
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
  };
  [key: string]: unknown;
}

export interface ClaudeSettings {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

export interface ClaudePermissionSuggestion {
  toolName: string;
  entry: string;
  isAllowed: boolean;
}

export interface PermissionGrantResult {
  success: boolean;
  alreadyAllowed?: boolean;
  updatedSettings?: ClaudeSettings;
}

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/**
 * Normalized controls supported by inline `<question-form>` artifacts.
 *
 * These are intentionally separate from the legacy AskUserQuestion types
 * above: inline forms use stable question ids and option values, while the
 * tool payload uses the question text as its answer key.
 */
export type QuestionFormQuestionType = 'radio' | 'checkbox' | 'select' | 'text' | 'textarea';

export interface QuestionFormOption {
  label: string;
  value: string;
  description?: string;
}

export type QuestionFormAnswer = string | string[];

export type QuestionFormAnswers = Record<string, QuestionFormAnswer>;

export type QuestionFormAnswerMap = QuestionFormAnswers;

export interface QuestionFormQuestion {
  id: string;
  label: string;
  type: QuestionFormQuestionType;
  options?: QuestionFormOption[];
  description?: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: QuestionFormAnswer;
}

export interface QuestionForm {
  id: string;
  title: string;
  description?: string;
  questions: QuestionFormQuestion[];
  submitLabel?: string;
  lang?: string;
}

export type QuestionFormSegment =
  | { kind: 'text'; text: string }
  | { kind: 'form'; form: QuestionForm; raw: string }
  | { kind: 'fallback'; text: string };

export type SessionNavigationOptions = {
  replace?: boolean;
};

export type SessionEstablishedContext = {
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

export interface ChatInterfaceProps {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  processingSessions?: SessionActivityMap;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
}
