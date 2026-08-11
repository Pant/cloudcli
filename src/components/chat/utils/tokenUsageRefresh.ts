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
  /** Enables canonical metadata hydration retries for providers that need them. */
  shouldRetryMessages?: (sessionId: string) => boolean;
  /** Captures canonical response metadata before the first forced refresh. */
  captureMetadataBaseline?: (sessionId: string) => unknown;
  /** Checks whether canonical metadata newer than the baseline is hydrated. */
  isMetadataReady?: (sessionId: string, baseline: unknown) => boolean;
  /** Delays before attempts after the immediate first attempt. */
  retryDelaysMs?: readonly number[];
  /** Injectable deterministic wait used by tests. */
  wait?: (delayMs: number) => Promise<void>;
  /** Reads one comprehensive provider token snapshot for the app session. */
  fetchTokenUsage: (sessionId: string) => Promise<unknown>;
  /** Applies a valid snapshot to the single state shared by badge and popup. */
  applySnapshot: (snapshot: Record<string, unknown>) => void;
  /** Monotonic version of trustworthy live token snapshots for stale fallback fencing. */
  getSnapshotVersion?: () => number;
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
  const wait = dependencies.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));
  const retryDelaysMs = dependencies.retryDelaysMs ?? [150, 350, 700, 1200];

  const isCurrent = (sessionId: string, ticket: number, viewKey: string): boolean => (
    latestTicketBySession.get(sessionId) === ticket
    && dependencies.getActiveSessionKey() === viewKey
    && dependencies.getActiveSessionId() === sessionId
  );

  const refresh = async (
    sessionId: string,
    ticket: number,
    viewKey: string,
    snapshotVersion: number,
  ): Promise<void> => {
    const refreshAggregateUsage = async (): Promise<void> => {
      try {
        const snapshot = await dependencies.fetchTokenUsage(sessionId);
        if (
          isCurrent(sessionId, ticket, viewKey)
          && (dependencies.getSnapshotVersion?.() ?? snapshotVersion) === snapshotVersion
          && isUsableSnapshot(snapshot)
        ) {
          dependencies.applySnapshot(snapshot);
        }
      } catch (error) {
        dependencies.onError?.(error);
      }
    };

    const refreshCanonicalMessages = async (): Promise<void> => {
      const retryMessages = dependencies.shouldRetryMessages?.(sessionId) === true;
      const baseline = retryMessages ? dependencies.captureMetadataBaseline?.(sessionId) : undefined;
      const delays = retryMessages ? [0, ...retryDelaysMs] : [0];

      for (const delayMs of delays) {
        if (!isCurrent(sessionId, ticket, viewKey)) return;
        if (delayMs > 0) {
          await wait(delayMs);
          if (!isCurrent(sessionId, ticket, viewKey)) return;
        }
        try {
          await dependencies.refreshMessages(sessionId);
        } catch (error) {
          dependencies.onError?.(error);
        }
        if (!isCurrent(sessionId, ticket, viewKey)) return;
        if (
          retryMessages
          && dependencies.isMetadataReady?.(sessionId, baseline) === true
        ) {
          break;
        }
      }

    };

    await Promise.all([refreshAggregateUsage(), refreshCanonicalMessages()]);
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
      return refresh(
        sessionId,
        ticket,
        viewKey!,
        dependencies.getSnapshotVersion?.() ?? 0,
      );
    },
  };
}
