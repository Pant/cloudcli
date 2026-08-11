import type { Project, ProjectSession } from '../../../types/app';

export type HierarchySession = ProjectSession & { __projectId?: string };

export type SessionHierarchyNode = {
  id: string;
  session: HierarchySession;
  parentSessionId: string | null;
  children: SessionHierarchyNode[];
  depth: number;
  ownActivity: number;
  subtreeActivity: number;
  isRunning: boolean;
  hasRunningDescendant: boolean;
  runningDescendantCount: number;
  needsAttention: boolean;
  hasAttentionDescendant: boolean;
};

export type SessionForest = {
  roots: SessionHierarchyNode[];
  nodes: ReadonlyMap<string, SessionHierarchyNode>;
};

export type FlatSessionRow = {
  session: HierarchySession;
  id: string;
  depth: number;
  parentSessionId: string | null;
  isRunning: boolean;
  hasRunningDescendant: boolean;
  runningDescendantCount: number;
  needsAttention: boolean;
  hasAttentionDescendant: boolean;
  childCount: number;
  descendantCount: number;
  subtreeActivity: number;
};

const toId = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const id = String(value).trim();
  return id || null;
};

const activityTime = (session: ProjectSession): number => {
  const value = session.lastActivity ?? session.updated_at ?? session.updatedAt ?? session.createdAt ?? session.created_at;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
};

const compareNodes = (left: SessionHierarchyNode, right: SessionHierarchyNode): number =>
  right.subtreeActivity - left.subtreeActivity
  || right.ownActivity - left.ownActivity
  || left.id.localeCompare(right.id);

/**
 * Builds a defensive forest from canonical app session ids. Duplicate ids are
 * merged, unknown/cross-project parents become roots, and a cycle is broken at
 * the edge that closes it. The input order is retained as the final tie-breaker
 * through the stable Map insertion order.
 */
export const buildSessionForest = (
  sessions: readonly ProjectSession[],
  projectId?: string,
): SessionForest => {
  const sessionById = new Map<string, HierarchySession>();

  for (const input of sessions) {
    const id = toId(input.id);
    if (!id) {
      continue;
    }

    const existing = sessionById.get(id);
    const merged: HierarchySession = existing ? { ...existing, ...input, id } : { ...input, id };
    if (projectId && merged.__projectId && merged.__projectId !== projectId) {
      continue;
    }
    sessionById.set(id, merged);
  }

  const rawParents = new Map<string, string | null>();
  for (const [id, session] of sessionById) {
    const parent = toId(session.parentSessionId);
    rawParents.set(
      id,
      parent
      && parent !== id
      && sessionById.has(parent)
      && (!projectId || sessionById.get(parent)?.__projectId === undefined || sessionById.get(parent)?.__projectId === projectId)
        ? parent
        : null,
    );
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const resolvedParents = new Map<string, string | null>();
  const resolve = (id: string, path: Set<string> = new Set()) => {
    const currentState = state.get(id);
    if (currentState === 'done') {
      return;
    }
    if (currentState === 'visiting' || path.has(id)) {
      resolvedParents.set(id, null);
      return;
    }

    state.set(id, 'visiting');
    path.add(id);
    const parent = rawParents.get(id) ?? null;
    if (parent) {
      resolve(parent, path);
      if (path.has(parent)) {
        resolvedParents.set(id, null);
      }
      // A parent that was part of a cycle may have had its edge removed. The
      // current edge is still safe: it terminates at that now-root node.
    }
    path.delete(id);
    resolvedParents.set(id, rawParents.get(id) ?? null);
    state.set(id, 'done');
  };

  for (const id of sessionById.keys()) {
    resolve(id);
  }

  // The recursion above breaks the closing edge, but a second pass makes the
  // invariant explicit for unusual state maps produced by malformed aliases.
  for (const id of sessionById.keys()) {
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor) {
      if (seen.has(cursor)) {
        resolvedParents.set(id, null);
        break;
      }
      seen.add(cursor);
      cursor = resolvedParents.get(cursor) ?? null;
    }
  }

  const nodes = new Map<string, SessionHierarchyNode>();
  for (const [id, session] of sessionById) {
    nodes.set(id, {
      id,
      session,
      parentSessionId: resolvedParents.get(id) ?? null,
      children: [],
      depth: 0,
      ownActivity: activityTime(session),
      subtreeActivity: activityTime(session),
      isRunning: false,
      hasRunningDescendant: false,
      runningDescendantCount: 0,
      needsAttention: false,
      hasAttentionDescendant: false,
    });
  }

  const roots: SessionHierarchyNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentSessionId ? nodes.get(node.parentSessionId) : undefined;
    if (!parent || parent === node) {
      node.parentSessionId = null;
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  const sortTree = (node: SessionHierarchyNode, depth: number): number => {
    node.depth = depth;
    node.children.sort(compareNodes);
    node.subtreeActivity = node.children.reduce(
      (latest, child) => Math.max(latest, sortTree(child, depth + 1)),
      node.ownActivity,
    );
    return node.subtreeActivity;
  };

  for (const root of roots) {
    sortTree(root, 0);
  }
  roots.sort(compareNodes);

  return { roots, nodes };
};

export const annotateSessionForest = (
  forest: SessionForest,
  activeSessionIds: ReadonlySet<string> = new Set(),
  attentionSessionIds: ReadonlySet<string> = new Set(),
): SessionForest => {
  const visit = (node: SessionHierarchyNode): { running: boolean; attention: boolean; runningCount: number } => {
    node.isRunning = activeSessionIds.has(node.id);
    node.needsAttention = attentionSessionIds.has(node.id);
    let running = node.isRunning;
    let attention = node.needsAttention;
    let runningCount = node.isRunning ? 1 : 0;
    for (const child of node.children) {
      const childState = visit(child);
      running ||= childState.running;
      attention ||= childState.attention;
      runningCount += childState.runningCount;
    }
    node.runningDescendantCount = Math.max(0, runningCount - (node.isRunning ? 1 : 0));
    node.hasRunningDescendant = node.runningDescendantCount > 0;
    node.hasAttentionDescendant = attention && !node.needsAttention;
    return { running, attention, runningCount };
  };

  for (const root of forest.roots) {
    visit(root);
  }
  return forest;
};

export const getSessionAncestorIds = (forest: SessionForest, sessionId: string): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  let node = forest.nodes.get(sessionId);
  while (node?.parentSessionId && !seen.has(node.parentSessionId)) {
    seen.add(node.parentSessionId);
    result.push(node.parentSessionId);
    node = forest.nodes.get(node.parentSessionId);
  }
  return result;
};

/**
 * Returns branches that need opening for canonical child edges not present in
 * the previous snapshot. A missing previous forest establishes a folded
 * baseline, and explicit collapses remain authoritative.
 */
export const getNewSessionEdgeAncestorIds = (
  previousForest: SessionForest | undefined,
  currentForest: SessionForest,
  collapsedSessionIds: ReadonlySet<string> = new Set(),
): Set<string> => {
  const expanded = new Set<string>();
  if (!previousForest) {
    return expanded;
  }

  for (const node of currentForest.nodes.values()) {
    if (!node.parentSessionId || previousForest.nodes.get(node.id)?.parentSessionId === node.parentSessionId) {
      continue;
    }
    for (const ancestorId of getSessionAncestorIds(currentForest, node.id)) {
      if (!collapsedSessionIds.has(ancestorId)) {
        expanded.add(ancestorId);
      }
    }
  }
  return expanded;
};

/**
 * Newly discovered session branches are intentionally folded. Explicit user
 * expansion is tracked by the sidebar controller and forced ancestor paths
 * are supplied separately to `flattenExpandedBranches`.
 */
export const getDefaultExpandedSessionIds = (_forest: SessionForest): Set<string> => new Set();

export const flattenExpandedBranches = (
  forest: SessionForest,
  expandedSessionIds: ReadonlySet<string>,
  forcedExpandedSessionIds: ReadonlySet<string> = new Set(),
): FlatSessionRow[] => {
  const result: FlatSessionRow[] = [];
  const visit = (node: SessionHierarchyNode) => {
    result.push({
      session: node.session,
      id: node.id,
      depth: node.depth,
      parentSessionId: node.parentSessionId,
      isRunning: node.isRunning,
      hasRunningDescendant: node.hasRunningDescendant,
      runningDescendantCount: node.runningDescendantCount,
      needsAttention: node.needsAttention,
      hasAttentionDescendant: node.hasAttentionDescendant,
      childCount: node.children.length,
      descendantCount: countDescendants(node),
      subtreeActivity: node.subtreeActivity,
    });
    if (expandedSessionIds.has(node.id) || forcedExpandedSessionIds.has(node.id)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };

  for (const root of forest.roots) {
    visit(root);
  }
  return result;
};

const countDescendants = (node: SessionHierarchyNode): number =>
  node.children.reduce((count, child) => count + 1 + countDescendants(child), 0);

export const deriveRunningSessions = (
  project: Project,
  activeSessionIds: ReadonlySet<string>,
): { forest: SessionForest; sessions: HierarchySession[]; exactActiveCount: number } => {
  const forest = annotateSessionForest(buildSessionForest(project.sessions ?? [], project.projectId), activeSessionIds);
  const included = new Set<string>();
  for (const activeId of activeSessionIds) {
    if (!forest.nodes.has(activeId)) {
      continue;
    }
    included.add(activeId);
    for (const ancestorId of getSessionAncestorIds(forest, activeId)) {
      included.add(ancestorId);
    }
  }

  const sessions = flattenExpandedBranches(
    forest,
    new Set(included),
    new Set(included),
  ).filter((row) => included.has(row.id)).map((row) => row.session);

  return {
    forest,
    sessions,
    exactActiveCount: [...activeSessionIds].filter((id) => forest.nodes.has(id)).length,
  };
};

export const deriveRunningProjects = (
  projects: readonly Project[],
  activeSessionIds: ReadonlySet<string>,
): Project[] => projects.reduce<Project[]>((result, project) => {
  const derived = deriveRunningSessions(project, activeSessionIds);
  if (derived.exactActiveCount === 0) {
    return result;
  }

  result.push({
    ...project,
    sessions: derived.sessions,
    sessionMeta: {
      ...project.sessionMeta,
      // Context ancestors are displayed but never counted as active agents.
      total: derived.exactActiveCount,
      hasMore: false,
      rootTotal: derived.sessions.filter((session) => !session.parentSessionId).length,
      rootOffset: 0,
      nextOffset: derived.sessions.length,
    },
  });
  return result;
}, []);

// Friendly aliases for consumers/tests that describe the same operations using
// slightly different terminology.
export const createSessionForest = buildSessionForest;
export const flattenSessionForest = flattenExpandedBranches;
