import fsSync from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import crossSpawn from 'cross-spawn';
import Database from 'better-sqlite3';

import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors
} from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderModelsDefinition,
  ProviderRuntimeContext,
  ProviderRuntimeError,
  ProviderRuntimeResult,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
  getOpenCodeDatabasePath,
} from '@/shared/utils.js';

import { readOpenCodeLatestAssistantWindowTokens } from './opencode-token-usage.provider.js';
import { createOpenCodeRunDiagnostics } from './opencode-run-diagnostics.provider.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

type OpenCodeProcess = ChildProcessWithoutNullStreams & {
  aborted?: boolean;
  sessionId?: string;
};

/** Sanitized process health consumed by provider recovery services. */
export type OpenCodeRuntimeDiagnostic = {
  state: 'missing' | 'alive' | 'exited';
  startedAt: number | null;
  lastOutputAt: number | null;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
};

type OpenCodeProcessRecord = {
  process: OpenCodeProcess;
  startedAt: number;
  lastOutputAt: number | null;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type OpenCodeRunOptions = {
  sessionId?: string;
  projectPath?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  sessionSummary?: string;
  images?: unknown;
  files?: unknown;
  permissionMode?: string;
  agent?: string;
};

type OpenCodePermissionOptions = {
  args: string[];
  env: Record<string, string>;
};

type OpenCodeTokenUsage = {
  used: number;
  windowTokens?: number;
  inputTokens: number;
  outputTokens: number;
  breakdown: {
    input: number;
    output: number;
  };
};

type OpenCodeTokenRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

type OpenCodeRunNotificationInput = {
  userId: string | number | null;
  provider: 'opencode';
  sessionId: string | null;
  sessionName?: string | null;
};

const notifyOpenCodeRunStopped = notifyRunStopped as unknown as (
  input: OpenCodeRunNotificationInput & { stopReason: string },
) => void;
const notifyOpenCodeRunFailed = notifyRunFailed as unknown as (
  input: OpenCodeRunNotificationInput & { error: unknown },
) => void;

const activeOpenCodeProcesses = new Map<string, OpenCodeProcessRecord>();
const exitedOpenCodeProcesses = new Map<string, OpenCodeRuntimeDiagnostic>();
const OPENCODE_ABORT_GRACE_MS = 2_000;
const OPENCODE_FALLBACK_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Maps the UI permission mode onto OpenCode's non-interactive controls.
 *
 * OpenCode has no single "permission mode" flag; each mode uses a different
 * lever of the `opencode run` CLI (verified against v1.17.13):
 * - plan              → the built-in read-only `plan` agent (`--agent plan`).
 * - bypassPermissions → `--auto`, which auto-approves every permission that
 *                       is not explicitly denied in the user's config.
 * - acceptEdits       → the OPENCODE_PERMISSION env var, whose JSON body the
 *                       CLI merges into its permission config. Forcing
 *                       `edit: allow` guarantees file edits go through while
 *                       every other rule stays under the user's own config.
 * - default           → nothing; the user's opencode.json governs. In
 *                       non-interactive `run` mode any `ask` rule is denied.
 *
 * Exported for tests only.
 */
export function resolveOpenCodePermissionOptions(permissionMode: unknown): OpenCodePermissionOptions {
  switch (permissionMode) {
    case 'plan':
      return { args: ['--agent', 'plan'], env: {} };
    case 'bypassPermissions':
      return { args: ['--auto'], env: {} };
    case 'acceptEdits':
      return { args: [], env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } };
    default:
      return { args: [], env: {} };
  }
}

function resolveOpenCodeEffort(
  model: string | undefined,
  effort: unknown,
  modelsDefinition: ProviderModelsDefinition | null,
): string | undefined {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model);
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  if (typeof effort !== 'string' || effort === 'default') {
    return undefined;
  }
  // Dynamically discovered OpenCode/custom-provider models do not always
  // publish variant metadata. In that case accept OpenCode's known reasoning
  // levels so the composer selection still reaches `opencode run --variant`.
  const supportedEfforts = allowedEfforts.length > 0
    ? new Set(allowedEfforts)
    : OPENCODE_FALLBACK_EFFORTS;
  return supportedEfforts.has(effort) ? effort : undefined;
}

function readOpenCodeSessionId(event: unknown): string | null {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const record = event as Record<string, unknown>;
  const sessionId = record.sessionID ?? record.sessionId;
  return typeof sessionId === 'string' ? sessionId : null;
}

function readOpenCodeTokenUsage(sessionId: string | null): OpenCodeTokenUsage | null {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const columns = db.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return null;
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
    `).get(sessionId) as OpenCodeTokenRow | undefined;

    if (!row) {
      return null;
    }

    const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const outputTokens = Number(row.outputTokens || 0);
    const used = Number(row.inputTokens || 0)
      + outputTokens
      + Number(row.reasoningTokens || 0)
      + Number(row.cacheReadTokens || 0)
      + Number(row.cacheWriteTokens || 0);
    const windowTokens = readOpenCodeLatestAssistantWindowTokens(db, sessionId, used === 0);

    return {
      used,
      ...(windowTokens === undefined ? {} : { windowTokens }),
      inputTokens,
      outputTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/** Used by the OpenCode provider runtime object and retained for direct runtime consumers. */
export async function spawnOpenCode(
  command: string,
  options: AnyRecord = {},
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<ProviderRuntimeResult> {
  return new Promise<ProviderRuntimeResult>((resolve, reject) => {
    const {
      sessionId,
      projectPath,
      cwd,
      model,
      effort,
      sessionSummary,
      images,
      files,
      permissionMode,
      agent
    } = options as OpenCodeRunOptions;
    // Callers pass the stable app session id; the CLI resumes with the
    // provider-native id recorded on the session row.
    const providerSessionId = context.resolveProviderSessionId(sessionId);
    const workingDir = cwd || projectPath || process.cwd();
    // Process-map key: the app session id when the caller supplied one, so
    // abort-by-app-id always works.
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = providerSessionId;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let opencodeProcess: OpenCodeProcess | null = null;
    // Unified lifecycle contract: exactly one terminal `complete` per run
    // (close and error handlers can both fire for spawn failures).
    let completeSent = false;

    const notifyTerminalState = ({
      code = null,
      error = null,
    }: { code?: number | null; error?: Error | null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      // Notifications are app-facing, so they carry the app session id.
      const finalSessionId = sessionId || capturedSessionId || processKey;
      if (code === 0 && !error) {
        notifyOpenCodeRunStopped({
          userId: ws.userId || null,
          provider: 'opencode',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyOpenCodeRunFailed({
        userId: ws.userId || null,
        provider: 'opencode',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `OpenCode CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId: string | null) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      // Legacy/direct callers without an app session id re-key the process
      // under the provider-native id once it is known.
      if (!sessionId && processKey !== capturedSessionId && opencodeProcess) {
        activeOpenCodeProcesses.delete(processKey);
        const record = activeOpenCodeProcesses.get(processKey);
        if (record) {
          activeOpenCodeProcesses.set(capturedSessionId, record);
        }
      }
      if (opencodeProcess) {
        opencodeProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId) {
        ws.setSessionId(capturedSessionId);
      }

      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'opencode',
        }));
      }
    };

    const processOpenCodeOutputLine = (line: string) => {
      if (!line || !line.trim()) {
        return;
      }

      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch {
        ws.send(createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
        return;
      }

      try {
        registerSession(readOpenCodeSessionId(response));
        const normalized = context.normalizeMessage(response, capturedSessionId || sessionId || null);
        for (const msg of normalized) {
          ws.send(msg);
        }
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[OpenCode] Failed to process JSON output:', errorContent);
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      }
    };

    void context.resolveResumeModel(sessionId, model).then(async (resolvedModel) => {
      let effortModels: ProviderModelsDefinition | null = null;
      try {
        effortModels = await context.getProviderModels();
      } catch (error) {
        console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
      }

      // Resolve supplemental metadata while the CLI is running so a slow
      // provider catalog lookup does not unnecessarily delay run completion.
      const contextWindowPromise = context.resolveContextWindow(resolvedModel).catch(() => undefined);

      const resolvedEffort = resolveOpenCodeEffort(resolvedModel, effort, effortModels);
      const args = ['run', '--format', 'json'];
      // OpenCode's `run` command owns workspace selection through `--dir`.
      // Relying on the child-process cwd alone is not enough on Linux, where
      // the CLI can still resolve the session under the server install dir.
      args.push('--dir', workingDir);
      if (providerSessionId) {
        args.push('--session', providerSessionId);
      }
      if (resolvedModel) {
        args.push('--model', resolvedModel);
      }
      if (resolvedEffort) {
        args.push('--variant', resolvedEffort);
      }
      const permissionOptions = resolveOpenCodePermissionOptions(permissionMode);
      // Plan mode is itself implemented by selecting OpenCode's plan agent and
      // therefore takes precedence over the composer-level agent choice.
      const selectedAgent = typeof agent === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(agent)
        ? agent
        : null;
      if (selectedAgent && permissionMode !== 'plan') {
        args.push('--agent', selectedAgent);
      }
      args.push(...permissionOptions.args);
      const hasAttachments =
        normalizeAttachmentDescriptors(images).length > 0
        || normalizeAttachmentDescriptors(files).length > 0;
      if ((command && command.trim()) || hasAttachments) {
        // Image attachments ride along as an <images_input> path list appended
        // to the prompt; the session history reader strips the tag back out.
        // opencode is a .cmd shim on Windows, so the whole argument must be
        // newline-free or cmd.exe silently truncates it at the first newline.
        const promptWithAttachments = appendFilesInputTag(
          appendImagesInputTag(command?.trim() || '', images),
          files
        );
        args.push(flattenPromptForWindowsShell(promptWithAttachments));
      }

      const startedAt = Date.now();
      const diagnostics = await createOpenCodeRunDiagnostics(startedAt);
      const spawnedProcess = spawnFunction('opencode', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...permissionOptions.env },
      }) as OpenCodeProcess;

      opencodeProcess = spawnedProcess;
      const processRecord: OpenCodeProcessRecord = {
        process: spawnedProcess,
        startedAt,
        lastOutputAt: null,
        exited: false,
        exitCode: null,
        signal: null,
      };
      activeOpenCodeProcesses.set(processKey, processRecord);
      exitedOpenCodeProcesses.delete(processKey);
      spawnedProcess.sessionId = processKey;
      spawnedProcess.stdin.end();

      spawnedProcess.stdout.on('data', (data: Buffer) => {
        diagnostics.appendStdout(data);
        processRecord.lastOutputAt = Date.now();
        stdoutLineBuffer += data.toString();
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';

        completeLines.forEach((line) => {
          processOpenCodeOutputLine(line.trim());
        });
      });

      spawnedProcess.stderr.on('data', (data: Buffer) => {
        diagnostics.appendStderr(data);
        processRecord.lastOutputAt = Date.now();
        const stderrText = data.toString();
        if (!stderrText.trim()) {
          return;
        }

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: stderrText,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      });

      spawnedProcess.on('close', async (code, signal) => {
        const finalSessionId = sessionId || capturedSessionId || processKey;
        processRecord.exited = true;
        processRecord.exitCode = code;
        processRecord.signal = signal;
        const runtimeResult = await diagnostics.finish({
          startedAt: processRecord.startedAt,
          endedAt: Date.now(),
          lastOutputAt: processRecord.lastOutputAt,
          exitCode: code,
          signal,
        });
        const terminalDiagnostic: OpenCodeRuntimeDiagnostic = {
          state: 'exited',
          startedAt: processRecord.startedAt,
          lastOutputAt: processRecord.lastOutputAt,
          exitCode: code,
          signal,
        };
        exitedOpenCodeProcesses.set(processKey, terminalDiagnostic);
        exitedOpenCodeProcesses.set(finalSessionId, terminalDiagnostic);
        activeOpenCodeProcesses.delete(finalSessionId);
        activeOpenCodeProcesses.delete(processKey);

        if (stdoutLineBuffer.trim()) {
          processOpenCodeOutputLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        // OpenCode's own database is keyed by the provider-native id.
        const tokenBudget = readOpenCodeTokenUsage(capturedSessionId);
        if (tokenBudget) {
          const contextWindow = await contextWindowPromise;
          const hasPositiveContextWindow = typeof contextWindow === 'number'
            && Number.isFinite(contextWindow)
            && contextWindow > 0;
          const tokenBudgetWithContextWindow = hasPositiveContextWindow
            ? { ...tokenBudget, total: contextWindow }
            : tokenBudget;
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: tokenBudgetWithContextWindow,
            sessionId: finalSessionId,
            provider: 'opencode',
          }));
        }

        // Terminal complete — skipped for aborted runs (abort-session
        // already sent the aborted complete on this run's behalf).
        if (!completeSent && !spawnedProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId, exitCode: code, signal }));
        }

        if (code === 0) {
          notifyTerminalState({ code });
          resolve(runtimeResult);
          return;
        }

        if (code === 127 || code === null) {
          const installed = await context.isProviderInstalled();
          if (!installed) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/',
              sessionId: finalSessionId,
              provider: 'opencode',
            }));
          }
        }

        notifyTerminalState({ code });
        const error = new Error(code === null
          ? `OpenCode CLI process was terminated${signal ? ` by ${signal}` : ''}`
          : `OpenCode CLI exited with code ${code}`) as ProviderRuntimeError;
        error.runtimeResult = runtimeResult;
        reject(error);
      });

      spawnedProcess.on('error', async (error) => {
        const finalSessionId = sessionId || capturedSessionId || processKey;
        processRecord.exited = true;
        processRecord.exitCode = spawnedProcess.exitCode;
        processRecord.signal = spawnedProcess.signalCode;
        const runtimeResult = await diagnostics.finish({
          startedAt: processRecord.startedAt,
          endedAt: Date.now(),
          lastOutputAt: processRecord.lastOutputAt,
          exitCode: spawnedProcess.exitCode,
          signal: spawnedProcess.signalCode,
        });
        const terminalDiagnostic: OpenCodeRuntimeDiagnostic = {
          state: 'exited',
          startedAt: processRecord.startedAt,
          lastOutputAt: processRecord.lastOutputAt,
          exitCode: spawnedProcess.exitCode,
          signal: spawnedProcess.signalCode,
        };
        exitedOpenCodeProcesses.set(processKey, terminalDiagnostic);
        exitedOpenCodeProcesses.set(finalSessionId, terminalDiagnostic);
        activeOpenCodeProcesses.delete(finalSessionId);
        activeOpenCodeProcesses.delete(processKey);

        const installed = await context.isProviderInstalled();
        const errorContent = !installed
          ? 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/'
          : error.message;

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: finalSessionId,
          provider: 'opencode',
        }));
        if (!completeSent && !spawnedProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId, exitCode: 1 }));
        }
        notifyTerminalState({ error });
        (error as ProviderRuntimeError).runtimeResult = runtimeResult;
        reject(error);
      });
    }).catch(reject);
  });
}

/** Used by the OpenCode provider runtime object and direct abort consumers. */
export async function abortOpenCodeSession(sessionId: string): Promise<boolean> {
  const record = activeOpenCodeProcesses.get(sessionId);
  if (!record || record.exited) {
    return false;
  }

  // The abort handler sends the terminal complete (aborted: true); flag the
  // process so its close handler does not emit a second one.
  const process = record.process;
  process.aborted = true;
  const waitForExit = () => new Promise<void>((resolve) => {
    if (record.exited || process.exitCode !== null || process.signalCode !== null) {
      resolve();
      return;
    }
    process.once('close', () => resolve());
    process.once('error', () => resolve());
  });
  process.kill('SIGTERM');
  const exited = await Promise.race([
    waitForExit().then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), OPENCODE_ABORT_GRACE_MS)),
  ]);
  if (!exited && !record.exited) {
    process.kill('SIGKILL');
    await waitForExit();
  }
  return true;
}

/** Used by runtime diagnostics to check whether an OpenCode session is active. */
export function isOpenCodeSessionActive(sessionId: string): boolean {
  return getOpenCodeRuntimeDiagnostic(sessionId).state === 'alive';
}

/** Provider recovery services use this sanitized snapshot instead of process handles. */
export function getOpenCodeRuntimeDiagnostic(sessionId: string): OpenCodeRuntimeDiagnostic {
  const record = activeOpenCodeProcesses.get(sessionId);
  if (record) {
    const exited = record.exited
      || record.process.exitCode !== null
      || record.process.signalCode !== null;
    return {
      state: exited ? 'exited' : 'alive',
      startedAt: record.startedAt,
      lastOutputAt: record.lastOutputAt,
      exitCode: record.exitCode ?? record.process.exitCode,
      signal: record.signal ?? record.process.signalCode,
    };
  }
  return exitedOpenCodeProcesses.get(sessionId) ?? {
    state: 'missing',
    startedAt: null,
    lastOutputAt: null,
    exitCode: null,
    signal: null,
  };
}

/** Used by runtime diagnostics to enumerate active OpenCode process keys. */
export function getActiveOpenCodeSessions(): string[] {
  return Array.from(activeOpenCodeProcesses.keys());
}

/** OpenCodeProvider consumes this as its provider-owned runtime facet. */
export const opencodeRuntime = {
  run: spawnOpenCode,
  abort: abortOpenCodeSession,
} satisfies IProviderRuntime;
