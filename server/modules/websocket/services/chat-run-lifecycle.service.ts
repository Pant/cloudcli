import { sessionRunStateDb, sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import type {
  AnyRecord,
  LLMProvider,
  NormalizedMessage,
  ProviderRuntimeError,
  ProviderRuntimeResult,
  RealtimeClientConnection,
  SessionContinuationOptions,
  SessionRunHistoryRecord,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type StartRunInput = {
  sessionId: string;
  command?: string;
  options?: AnyRecord;
  connection?: RealtimeClientConnection | null;
  userId?: string | number | null;
  claimedGeneration?: number;
};

type RestartRunInput = Omit<StartRunInput, 'command'>;

type TerminalEvidence = {
  result?: ProviderRuntimeResult;
  message?: NormalizedMessage;
  error?: unknown;
};

function isRuntimeResult(value: unknown): value is ProviderRuntimeResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<ProviderRuntimeResult>;
  return typeof result.startedAt === 'number' && typeof result.endedAt === 'number'
    && (typeof result.exitCode === 'number' || result.exitCode === null)
    && (typeof result.signal === 'string' || result.signal === null);
}

function messageSignal(message: NormalizedMessage | undefined): NodeJS.Signals | null {
  return typeof message?.signal === 'string' ? message.signal as NodeJS.Signals : null;
}

function terminalClassification(evidence: TerminalEvidence): Pick<SessionRunHistoryRecord,
  'lifecycleState' | 'terminalReason' | 'exitCode' | 'signal'> & { terminalMessage: string | null } {
  const result = evidence.result;
  const messageCode = typeof evidence.message?.exitCode === 'number' ? evidence.message.exitCode : null;
  const exitCode = result ? result.exitCode : messageCode;
  const signal = result?.signal ?? messageSignal(evidence.message);
  const errorMessage = evidence.error instanceof Error ? evidence.error.message
    : evidence.error === undefined ? null : String(evidence.error);
  if (evidence.error || (typeof exitCode === 'number' && exitCode !== 0)) {
    return { lifecycleState: 'failed', terminalReason: 'provider_error', terminalMessage: errorMessage, exitCode: exitCode ?? 1, signal };
  }
  if (signal) {
    return { lifecycleState: 'exited', terminalReason: 'process_exited', terminalMessage: null, exitCode, signal };
  }
  return { lifecycleState: 'completed', terminalReason: 'completed', terminalMessage: null, exitCode: exitCode ?? 0, signal: null };
}

function continuationOptions(session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>, options: AnyRecord): SessionContinuationOptions {
  return {
    ...(typeof options.model === 'string' ? { model: options.model } : session.model ? { model: session.model } : {}),
    ...(typeof options.effort === 'string' ? { effort: options.effort } : {}),
    ...(typeof options.agent === 'string' ? { agent: options.agent } : session.agent ? { agent: session.agent } : {}),
    ...(typeof options.permissionMode === 'string' ? { permissionMode: options.permissionMode } : {}),
    cwd: typeof options.cwd === 'string' ? options.cwd : session.project_path ?? undefined,
    projectPath: typeof options.projectPath === 'string' ? options.projectPath : session.project_path ?? undefined,
  };
}

/** WebSocket and provider routes use this owner for all durable run transitions. */
export const chatRunLifecycleService = {
  async start(input: StartRunInput) {
    const session = sessionsDb.getSessionById(input.sessionId);
    if (!session) throw new AppError(`Session "${input.sessionId}" was not found.`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    const provider = session.provider as LLMProvider;
    if (!providerRuntimeService.hasRuntime(provider)) throw new AppError(`Provider "${provider}" is not available.`, { code: 'UNSUPPORTED_PROVIDER', statusCode: 400 });
    if (chatRunRegistry.isProcessing(input.sessionId)) throw new AppError(`Session "${input.sessionId}" already has a run in progress.`, { code: 'RUN_IN_PROGRESS', statusCode: 409 });
    const options = input.options ?? {};
    const safeOptions = continuationOptions(session, options);
    const state = input.claimedGeneration
      ? sessionRunStateDb.getById(input.sessionId)
      : sessionRunStateDb.beginRun({ sessionId: input.sessionId, provider, continuationOptions: safeOptions });
    if (!state || (input.claimedGeneration && state.generation !== input.claimedGeneration)) throw new AppError('Run generation is no longer current.', { code: 'STALE_RUN_GENERATION', statusCode: 409 });
    if (typeof options.model === 'string' && options.model.trim()) providerModelsService.setSessionModel(provider, input.sessionId, options.model);
    if (provider === 'opencode' && typeof options.agent === 'string' && options.agent.trim()) sessionsDb.setSessionAgent(input.sessionId, options.agent.trim());
    let completeMessage: NormalizedMessage | undefined;
    let finalized = false;
    const finalize = (evidence: TerminalEvidence): void => {
      if (finalized) return;
      const current = sessionRunStateDb.getById(input.sessionId);
      if (!current || current.generation !== state.generation || current.lifecycleState === 'manually_stopped') return;
      finalized = true;
      const terminal = terminalClassification(evidence);
      const result = evidence.result;
      const terminalAt = result?.endedAt ?? Date.now();
      sessionRunStateDb.recordTerminal(input.sessionId, state.generation, {
        lifecycleState: terminal.lifecycleState,
        terminalReason: terminal.terminalReason,
        terminalMessage: terminal.terminalMessage,
        exitCode: terminal.exitCode,
        now: terminalAt,
      });
      sessionRunStateDb.appendHistory({
        sessionId: input.sessionId,
        generation: state.generation,
        provider,
        startedAt: result?.startedAt ?? state.startedAt,
        terminalAt,
        lifecycleState: terminal.lifecycleState,
        terminalReason: terminal.terminalReason,
        terminalMessage: terminal.terminalMessage,
        exitCode: terminal.exitCode,
        signal: terminal.signal,
        diagnostic: result?.diagnostic,
        stderrTail: result?.stderrTail,
        resources: result?.resources,
      });
    };
    const run = chatRunRegistry.startRun({
      appSessionId: input.sessionId, provider, providerSessionId: session.provider_session_id,
      connection: input.connection ?? null, userId: input.userId ?? null, generation: state.generation,
      onProgress: (generation, message) => {
        if (message.kind !== 'complete') sessionRunStateDb.recordProgress(input.sessionId, generation);
      },
      onComplete: (generation, message) => {
        if (generation === state.generation && message.aborted !== true) completeMessage = message;
      },
    });
    if (!run) throw new AppError('Run already in progress.', { code: 'RUN_IN_PROGRESS', statusCode: 409 });
    const runtimeOptions: AnyRecord = { ...safeOptions, ...options, sessionId: input.sessionId, cwd: safeOptions.cwd, projectPath: safeOptions.projectPath };
    void providerRuntimeService.run(provider, input.command ?? '', runtimeOptions, run.writer).then((value) => {
      const result = isRuntimeResult(value) ? value : undefined;
      finalize({ result, message: completeMessage });
      chatRunRegistry.completeRunIfCurrent(run, {
        exitCode: result?.exitCode ?? (typeof completeMessage?.exitCode === 'number' ? completeMessage.exitCode : 0),
        signal: result?.signal ?? messageSignal(completeMessage),
      });
    }).catch((error: ProviderRuntimeError) => {
      const result = isRuntimeResult(error.runtimeResult) ? error.runtimeResult : undefined;
      finalize({ result, message: completeMessage, error });
      chatRunRegistry.completeRunIfCurrent(run, { exitCode: result?.exitCode ?? 1, signal: result?.signal ?? undefined });
    });
    return { sessionId: input.sessionId, provider, generation: state.generation };
  },

  async restart(input: RestartRunInput) { return this.start({ ...input, command: 'Continue' }); },

  async manualStart(sessionId: string) { return this.restart({ sessionId }); },

  async stop(sessionId: string): Promise<boolean> {
    const run = chatRunRegistry.getRun(sessionId);
    if (!run || run.status !== 'running') return false;
    sessionRunStateDb.requestManualStop(sessionId, run.generation);
    const stopped = await providerRuntimeService.abort(run.provider, sessionId);
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: stopped ? 0 : 1, aborted: true });
    return stopped;
  },
};
