export function getLazyToolRendererFamily(toolName: string, contentType?: string, isSubagentContainer?: boolean): string | null {
  if (isSubagentContainer) return 'subagent';
  if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') return 'plan';
  if (contentType === 'diff' || contentType === 'todo-list' || contentType === 'task' || contentType === 'question-answer') return contentType;
  if (contentType === 'markdown' && toolName === 'Task') return 'subagent-markdown';
  return null;
}
