import { useCallback, useState } from 'react';

import type {
  LLMProvider,
  Project,
  ProjectSession,
  RunningSessionAncestorSnapshot,
  RunningSessionSnapshot,
  SessionLifecycleSnapshot,
} from '../types/app';

export interface SessionActivity {
  /** Provider-supplied status line; null renders the default activity label. */
  statusText: string | null;
  canInterrupt: boolean;
  /**
   * When this request was first marked as processing (client clock). Drives
   * the elapsed-time display and the stale `chat_subscribed` idle-ack guard.
   */
  startedAt: number;
  /** Canonical hierarchy metadata from the latest running snapshot. */
  provider?: LLMProvider;
  parentSessionId?: string | null;
  session?: ProjectSession | null;
  project?: Pick<Project, 'projectId' | 'path' | 'fullPath' | 'displayName' | 'isStarred'> | null;
  /** Inactive hierarchy context carried by the exact running snapshot. */
  ancestors?: RunningSessionAncestorSnapshot[];
  lastSeq?: number;
  /** True until the activity appears in an authoritative running snapshot. */
  locallyStarted?: boolean;
}

export type SessionActivityMap = ReadonlyMap<string, SessionActivity>;
export type SessionLifecycleMap = ReadonlyMap<string, SessionLifecycleSnapshot>;

export type SessionActivitySnapshot = RunningSessionSnapshot & {
  sessionId: string;
};

export type MarkSessionProcessing = (
  sessionId?: string | null,
  activity?: { statusText?: string | null; canInterrupt?: boolean },
) => void;

export type MarkSessionIdle = (
  sessionId?: string | null,
  opts?: { ifStartedBefore?: number },
) => void;

export type SyncProcessingSessions = (
  sessions: readonly SessionActivitySnapshot[],
) => void;

const LOCAL_ACTIVITY_GRACE_MS = 10_000;

export const reconcileLifecycleSnapshots = (
  snapshots: readonly SessionLifecycleSnapshot[],
): Map<string, SessionLifecycleSnapshot> => new Map(
  snapshots.filter((snapshot) => Boolean(snapshot.sessionId)).map((snapshot) => [snapshot.sessionId, snapshot]),
);

export const reconcileProcessingSnapshots = (
  previous: ReadonlyMap<string, SessionActivity>,
  sessions: readonly SessionActivitySnapshot[],
  now = Date.now(),
): Map<string, SessionActivity> => {
  const incoming = new Map(sessions.filter((session) => Boolean(session.sessionId)).map((session) => [session.sessionId, session]));
  const updated = new Map<string, SessionActivity>();
  for (const [sessionId, snapshot] of incoming) {
    const existing = previous.get(sessionId);
    const snapshotStartedAt = typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0
      ? snapshot.startedAt
      : undefined;
    updated.set(sessionId, {
      statusText: snapshot.statusText !== undefined ? snapshot.statusText : existing?.statusText ?? null,
      canInterrupt: snapshot.canInterrupt ?? existing?.canInterrupt ?? true,
      startedAt: snapshotStartedAt ?? existing?.startedAt ?? now,
      provider: snapshot.provider ?? existing?.provider,
      parentSessionId: snapshot.parentSessionId !== undefined ? snapshot.parentSessionId : existing?.parentSessionId,
      session: snapshot.session ? { ...snapshot.session, id: snapshot.session.id ?? sessionId, provider: snapshot.session.provider ?? snapshot.provider ?? existing?.session?.provider } as ProjectSession : existing?.session ?? null,
      project: snapshot.project ? { ...snapshot.project, projectId: snapshot.project.projectId ?? existing?.project?.projectId ?? '' } as SessionActivity['project'] : existing?.project ?? null,
      lastSeq: typeof snapshot.lastSeq === 'number' ? snapshot.lastSeq : existing?.lastSeq,
      ancestors: snapshot.ancestors ?? existing?.ancestors,
      locallyStarted: false,
    });
  }
  for (const [sessionId, activity] of previous) {
    if (!incoming.has(sessionId) && activity.locallyStarted && now - activity.startedAt < LOCAL_ACTIVITY_GRACE_MS) updated.set(sessionId, activity);
  }
  return updated;
};

const sessionActivityMapsMatch = (
  left: ReadonlyMap<string, SessionActivity>,
  right: ReadonlyMap<string, SessionActivity>,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [sessionId, leftActivity] of left) {
    const rightActivity = right.get(sessionId);
    if (
      !rightActivity
      || leftActivity.statusText !== rightActivity.statusText
      || leftActivity.canInterrupt !== rightActivity.canInterrupt
      || leftActivity.startedAt !== rightActivity.startedAt
      || leftActivity.provider !== rightActivity.provider
      || leftActivity.parentSessionId !== rightActivity.parentSessionId
      || leftActivity.lastSeq !== rightActivity.lastSeq
      || JSON.stringify(leftActivity.ancestors) !== JSON.stringify(rightActivity.ancestors)
      || JSON.stringify(leftActivity.session) !== JSON.stringify(rightActivity.session)
      || JSON.stringify(leftActivity.project) !== JSON.stringify(rightActivity.project)
    ) {
      return false;
    }
  }

  return true;
};

/**
 * Single source of truth for which sessions are actively processing a
 * request. Everything the chat UI shows (activity indicator, abort
 * availability, status text) is derived from this map; terminal events
 * (`complete`, abort, an authoritative idle subscribe ack) delete the entry
 * atomically. Session ids are always concrete (allocated before the first
 * send), so entries are keyed by real session ids only.
 */
export function useSessionProtection() {
  const [processingSessions, setProcessingSessions] = useState<Map<string, SessionActivity>>(
    new Map(),
  );
  const [sessionLifecycle, setSessionLifecycle] = useState<Map<string, SessionLifecycleSnapshot>>(new Map());

  const markSessionProcessing = useCallback<MarkSessionProcessing>((sessionId, activity) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      const next: SessionActivity = {
        statusText:
          activity?.statusText !== undefined ? activity.statusText : existing?.statusText ?? null,
        canInterrupt: activity?.canInterrupt ?? existing?.canInterrupt ?? true,
        startedAt: existing?.startedAt ?? Date.now(),
        locallyStarted: existing?.locallyStarted ?? true,
      };

      if (
        existing
        && existing.statusText === next.statusText
        && existing.canInterrupt === next.canInterrupt
      ) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(sessionId, next);
      return updated;
    });
  }, []);

  const markSessionIdle = useCallback<MarkSessionIdle>((sessionId, opts) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      if (!existing) {
        return prev;
      }

      // Guard against stale `chat_subscribed` idle acks: if a new request
      // started after the subscribe was sent, the idle ack describes the
      // older request and must not clear the newer one.
      if (opts?.ifStartedBefore !== undefined && existing.startedAt >= opts.ifStartedBefore) {
        return prev;
      }

      const updated = new Map(prev);
      updated.delete(sessionId);
      return updated;
    });
  }, []);

  const syncProcessingSessions = useCallback<SyncProcessingSessions>((sessions) => {
    const now = Date.now();

    setProcessingSessions((prev) => {
      const updated = reconcileProcessingSnapshots(prev, sessions, now);
      return sessionActivityMapsMatch(prev, updated) ? prev : updated;
    });
  }, []);

  const syncSessionLifecycle = useCallback((snapshots: readonly SessionLifecycleSnapshot[]) => {
    setSessionLifecycle((previous) => {
      const next = reconcileLifecycleSnapshots(snapshots);
      return JSON.stringify([...previous]) === JSON.stringify([...next]) ? previous : next;
    });
  }, []);

  return {
    processingSessions,
    sessionLifecycle,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
    syncSessionLifecycle,
  };
}
