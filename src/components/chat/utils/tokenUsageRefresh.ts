export type CompletionTokenRefreshEvent = {
  sessionId?: string | null;
  success?: boolean;
  aborted?: boolean;
};

export type CompletionTokenRefreshDependencies = {
  /** Returns the current viewed app session id. */
  getActiveSessionId: () => string | null;
  /** Returns the current viewed-session identity, including its view generation. */
  getActiveSessionKey: () => string | null;
  /** Reconciles persisted messages before provider token storage is read. */
  refreshMessages: (sessionId: string) => Promise<unknown>;
  /** Reads one comprehensive provider token snapshot for the app session. */
  fetchTokenUsage: (sessionId: string) => Promise<unknown>;
  /** Applies a valid snapshot to the single state shared by badge and popup. */
  applySnapshot: (snapshot: Record<string, unknown>) => void;
  /** Completion refresh is supplemental; failures retain the live snapshot. */
  onError?: (error: unknown) => void;
};

const isUsableSnapshot = (value: unknown): value is Record<string, unknown> => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && (value as Record<string, unknown>).unsupported !== true
);

/**
 * Creates the completion refresh coordinator used by realtime chat handling.
 *
 * One monotonic ticket is maintained per app session. A later completion for
 * the same session invalidates an older in-flight REST request, while the
 * active view key prevents a result from a previous session/view generation
 * from changing the visible badge and popup.
 */
export function createCompletionTokenRefreshController(
  dependencies: CompletionTokenRefreshDependencies,
) {
  const latestTicketBySession = new Map<string, number>();

  const refresh = async (sessionId: string, ticket: number, viewKey: string): Promise<void> => {
    try {
      try {
        await dependencies.refreshMessages(sessionId);
      } catch (error) {
        // Message persistence and token storage can settle through separate
        // provider paths. Still attempt the authoritative token read if the
        // transcript refresh failed; either failure retains the prior snapshot.
        dependencies.onError?.(error);
      }
      if (
        latestTicketBySession.get(sessionId) !== ticket
        || dependencies.getActiveSessionKey() !== viewKey
        || dependencies.getActiveSessionId() !== sessionId
      ) {
        return;
      }

      const snapshot = await dependencies.fetchTokenUsage(sessionId);
      if (
        latestTicketBySession.get(sessionId) === ticket
        && dependencies.getActiveSessionKey() === viewKey
        && dependencies.getActiveSessionId() === sessionId
        && isUsableSnapshot(snapshot)
      ) {
        dependencies.applySnapshot(snapshot);
      }
    } catch (error) {
      dependencies.onError?.(error);
    }
  };

  return {
    handleComplete(event: CompletionTokenRefreshEvent): Promise<void> | undefined {
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
      const activeSessionId = dependencies.getActiveSessionId();
      const viewKey = dependencies.getActiveSessionKey();
      if (
        !sessionId
        || event.success === false
        || event.aborted
        || activeSessionId !== sessionId
      ) {
        return undefined;
      }

      const ticket = (latestTicketBySession.get(sessionId) ?? 0) + 1;
      latestTicketBySession.set(sessionId, ticket);
      return refresh(sessionId, ticket, viewKey!);
    },
  };
}
