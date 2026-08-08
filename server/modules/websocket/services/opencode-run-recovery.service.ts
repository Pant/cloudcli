import { sessionRunStateDb, sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';

type StartupReconciliationOptions = { limit?: number; now?: () => number };
const STARTUP_INTERRUPTION_MESSAGE = 'CloudCLI restarted while this session was running. Use Restart to continue.';

/** Server startup uses one bounded inspection pass to surface interrupted OpenCode runs without executing providers. */
export function reconcileInterruptedOpenCodeRuns(options: StartupReconciliationOptions = {}): number {
  const timestamp = (options.now ?? Date.now)();
  const children = new Map(providerRuntimeService.listChildActivity('opencode').map((item) => [item.providerSessionId, item]));
  let reconciled = 0;
  for (const state of sessionRunStateDb.listStartupReconciliationCandidates(options.limit ?? 200)) {
    if (state.provider !== 'opencode') continue;
    const row = sessionsDb.getSessionById(state.sessionId);
    const registry = chatRunRegistry.getRun(state.sessionId);
    const runtime = providerRuntimeService.getHealth('opencode', state.sessionId);
    const child = row?.provider_session_id ? children.get(row.provider_session_id) : undefined;
    const hasLiveEvidence = registry?.status === 'running'
      || runtime?.state === 'alive'
      || child?.state === 'running'
      || providerRuntimeService.getPendingApprovalsForSession(state.sessionId).length > 0;
    if (!hasLiveEvidence && sessionRunStateDb.markStartupInterrupted(state.sessionId, state.generation, STARTUP_INTERRUPTION_MESSAGE, timestamp)) reconciled += 1;
  }
  return reconciled;
}
