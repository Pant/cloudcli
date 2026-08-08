export const MAX_SESSION_ROW_DEPTH = 8;

/**
 * Keeps deep OpenCode trees usable in the narrow sidebar while preserving
 * enough indentation for the common root/child/grandchild case.
 */
export const getSessionRowIndent = (depth: number): number => {
  const normalizedDepth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  return 8 + Math.min(normalizedDepth, MAX_SESSION_ROW_DEPTH) * 16;
};

export type SessionRowInteractionPolicy = {
  selectsOnRowClick: true;
  togglesOnRowClick: boolean;
  disclosureStopsPropagation: true;
};

/**
 * The row remains a conversation target even when it owns a branch. The
 * disclosure button is the opt-in branch-only interaction.
 */
export const getSessionRowInteractionPolicy = (hasChildren: boolean): SessionRowInteractionPolicy => ({
  selectsOnRowClick: true,
  togglesOnRowClick: hasChildren,
  disclosureStopsPropagation: true,
});
