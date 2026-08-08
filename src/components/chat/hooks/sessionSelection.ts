export type CommittedSessionIdentity = {
  kind: 'selected' | 'draft';
  sessionId: string;
  projectId: string;
  key: string;
};

export function createSessionIdentity(
  kind: CommittedSessionIdentity['kind'],
  sessionId: string,
  projectId: string,
): CommittedSessionIdentity {
  return { kind, sessionId, projectId, key: `${kind}:${sessionId}:${projectId}` };
}

export function resolveCommittedSessionIdentity(options: {
  selectedSessionId: string | null;
  projectId: string | null;
  draft: CommittedSessionIdentity | null;
}): CommittedSessionIdentity | null {
  const { selectedSessionId, projectId, draft } = options;
  if (!projectId) return null;
  if (selectedSessionId) return createSessionIdentity('selected', selectedSessionId, projectId);
  return draft?.projectId === projectId ? draft : null;
}

export function isCommittedIdentityCurrent(
  expected: CommittedSessionIdentity | null,
  current: CommittedSessionIdentity | null,
): boolean {
  return expected !== null && expected.key === current?.key;
}

export function stabilizeSessionIdentity(
  previous: CommittedSessionIdentity | null,
  next: CommittedSessionIdentity | null,
): CommittedSessionIdentity | null {
  return previous?.key === next?.key ? previous : next;
}

export function shouldAdoptCanonicalSelection(
  draft: CommittedSessionIdentity | null,
  selected: CommittedSessionIdentity | null,
): boolean {
  return Boolean(draft && selected && draft.sessionId === selected.sessionId && draft.projectId === selected.projectId);
}
