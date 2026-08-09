import React, { lazy, memo, Suspense, useMemo, useCallback } from 'react';

import type { Project } from '../../../types/app';
import type { SubagentChildTool } from '../types/types';

import { getToolConfig, TOOL_CONFIGS } from './configs/toolConfigs';
import { OneLineDisplay } from './components/OneLineDisplay';
import { BashCommandDisplay } from './components/BashCommandDisplay';
import { CollapsibleDisplay } from './components/CollapsibleDisplay';
import { FileListContent } from './components/ContentRenderers/FileListContent';
import { TextContent } from './components/ContentRenderers/TextContent';
import { ToolStatusBadge } from './components/ToolStatusBadge';
import type { ToolStatus } from './components/ToolStatusBadge';

const ToolDiffViewer = lazy(() => import('./components/ToolDiffViewer').then((module) => ({ default: module.ToolDiffViewer })));
const ApplyPatchDisplay = lazy(() => import('./components/ApplyPatchDisplay').then((module) => ({ default: module.ApplyPatchDisplay })));
const MarkdownContent = lazy(() => import('./components/ContentRenderers/MarkdownContent').then((module) => ({ default: module.MarkdownContent })));
const TodoListContent = lazy(() => import('./components/ContentRenderers/TodoListContent').then((module) => ({ default: module.TodoListContent })));
const TaskListContent = lazy(() => import('./components/ContentRenderers/TaskListContent').then((module) => ({ default: module.TaskListContent })));
const QuestionAnswerContent = lazy(() => import('./components/ContentRenderers/QuestionAnswerContent').then((module) => ({ default: module.QuestionAnswerContent })));
const SubagentContainer = lazy(() => import('./components/SubagentContainer').then((module) => ({ default: module.SubagentContainer })));
const PlanDisplay = lazy(() => import('./components/PlanDisplay').then((module) => ({ default: module.PlanDisplay })));

function ToolRendererFallback() {
  return <div className="h-7 rounded-md border border-border/50 bg-muted/20" aria-hidden="true" />;
}

function LazyToolFamily({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<ToolRendererFallback />}>{children}</Suspense>;
}

type DiffLine = {
  type: string;
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

interface ToolRendererProps {
  toolName: string;
  toolInput: any;
  toolResult?: any;
  toolId?: string;
  mode: 'input' | 'result';
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  createDiff?: (oldStr: string, newStr: string) => DiffLine[];
  selectedProject?: Project | null;
  showRawParameters?: boolean;
  rawToolInput?: string;
  isSubagentContainer?: boolean;
  subagentState?: {
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
  };
}

function getToolCategory(toolName: string): string {
  if (['Edit', 'Write', 'ApplyPatch'].includes(toolName)) return 'edit';
  if (['Grep', 'Glob'].includes(toolName)) return 'search';
  if (toolName === 'Bash') return 'bash';
  if (['TodoWrite', 'TodoRead'].includes(toolName)) return 'todo';
  if (['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(toolName)) return 'task';
  if (toolName === 'Task') return 'agent';
  if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') return 'plan';
  if (toolName === 'AskUserQuestion') return 'question';
  return 'default';
}

// Exact denial messages from the Claude runtime adapter — other providers can't reliably signal denial
const CLAUDE_DENIAL_MESSAGES = [
  'user denied tool use',
  'tool disallowed by settings',
  'permission request timed out',
  'permission request cancelled',
];

function deriveToolStatus(toolResult: any): ToolStatus {
  if (!toolResult) return 'running';
  if (toolResult.isError) {
    const content = String(toolResult.content || '').toLowerCase().trim();
    if (CLAUDE_DENIAL_MESSAGES.some((msg) => content.includes(msg))) {
      return 'denied';
    }
    return 'error';
  }
  return 'completed';
}

/**
 * Main tool renderer router
 * Routes to OneLineDisplay or CollapsibleDisplay based on tool config
 */
export const ToolRenderer: React.FC<ToolRendererProps> = memo(({
  toolName,
  toolInput,
  toolResult,
  toolId,
  mode,
  onFileOpen,
  createDiff,
  selectedProject,
  showRawParameters = false,
  rawToolInput,
  isSubagentContainer,
  subagentState
}) => {
  const config = getToolConfig(toolName);
  const usesFallbackConfig = config === TOOL_CONFIGS.Default;
  // The fallback body already contains the formatted raw input.
  const shouldShowRawParameters = mode === 'input' && showRawParameters && !usesFallbackConfig;
  const displayConfig: any = mode === 'input' ? config.input : config.result;

  const parsedData = useMemo(() => {
    try {
      const rawData = mode === 'input' ? toolInput : toolResult;
      return typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    } catch {
      return mode === 'input' ? toolInput : toolResult;
    }
  }, [mode, toolInput, toolResult]);

  // Only derive and show status badge on input renders
  const toolStatus = useMemo(
    () => mode === 'input' ? deriveToolStatus(toolResult) : undefined,
    [mode, toolResult],
  );

  const handleAction = useCallback(() => {
    if (displayConfig?.action === 'open-file' && onFileOpen) {
      const value = displayConfig.getValue?.(parsedData) || '';
      onFileOpen(value);
    }
  }, [displayConfig, parsedData, onFileOpen]);

  // Route subagent containers to dedicated component (after hooks to satisfy Rules of Hooks)
  if (isSubagentContainer && subagentState) {
    if (mode === 'result') return null;
    return (
      <LazyToolFamily>
        <SubagentContainer
          toolInput={toolInput}
          toolResult={toolResult}
          subagentState={subagentState}
        />
      </LazyToolFamily>
    );
  }

  if (!displayConfig) return null;

  // Bash renders as a Codex-style command row: the command on a single line with
  // a chevron that expands to show the output inline. The combined view lives on
  // the input render; the separate result section is suppressed in MessageComponent.
  if (toolName === 'Bash' && mode === 'input') {
    const command = typeof parsedData === 'object' && parsedData !== null && 'command' in parsedData
      ? String(parsedData.command || '')
      : typeof toolInput === 'string'
        ? toolInput
        : typeof rawToolInput === 'string'
          ? rawToolInput
          : '';
    const description = typeof parsedData === 'object' && parsedData !== null && 'description' in parsedData
      ? String(parsedData.description || '')
      : undefined;
    const output = typeof toolResult?.content === 'string'
      ? toolResult.content
      : toolResult?.content != null
        ? String(toolResult.content)
        : '';
    return (
      <BashCommandDisplay
        command={command}
        description={description}
        output={output}
        isError={Boolean(toolResult?.isError)}
        status={toolStatus !== 'completed' ? toolStatus : undefined}
        // Commands stay collapsed by default — including failures; the status
        // badge marks errors and the output expands via the chevron.
        defaultOpen={false}
      />
    );
  }

  if (displayConfig.type === 'one-line') {
    const value = displayConfig.getValue?.(parsedData) || '';
    const secondary = displayConfig.getSecondary?.(parsedData);

    return (
      <OneLineDisplay
        toolName={toolName}
        toolResult={toolResult}
        toolId={toolId}
        icon={displayConfig.icon}
        label={displayConfig.label}
        value={value}
        secondary={secondary}
        action={displayConfig.action}
        onAction={handleAction}
        style={displayConfig.style}
        wrapText={displayConfig.wrapText}
        colorScheme={displayConfig.colorScheme}
        resultId={mode === 'input' ? `tool-result-${toolId}` : undefined}
        status={toolStatus !== 'completed' ? toolStatus : undefined}
      />
    );
  }

  if (displayConfig.type === 'plan') {
    const title = typeof displayConfig.title === 'function'
      ? displayConfig.title(parsedData)
      : displayConfig.title || 'Plan';

    const contentProps = displayConfig.getContentProps?.(parsedData, {
      selectedProject,
      createDiff,
      onFileOpen
    }) || {};

    const isStreaming = mode === 'input' && !toolResult;

    return (
      <LazyToolFamily>
        <PlanDisplay
          title={title}
          content={contentProps.content || ''}
          defaultOpen={displayConfig.defaultOpen ?? false}
          isStreaming={isStreaming}
          showRawParameters={shouldShowRawParameters}
          rawContent={rawToolInput}
          toolName={toolName}
          toolId={toolId}
        />
      </LazyToolFamily>
    );
  }

  if (displayConfig.type === 'collapsible') {
    const title = typeof displayConfig.title === 'function'
      ? displayConfig.title(parsedData)
      : displayConfig.title || 'Details';

    const defaultOpen = displayConfig.defaultOpen !== undefined
      ? displayConfig.defaultOpen
      : false;

    const contentProps = displayConfig.getContentProps?.(parsedData, {
      selectedProject,
      createDiff,
      onFileOpen
    }) || {};

    let contentComponent: React.ReactNode = null;

    switch (displayConfig.contentType) {
      case 'diff':
        if (createDiff) {
          contentComponent = (
            <LazyToolFamily>
            <ToolDiffViewer
              {...contentProps}
              createDiff={createDiff}
              onFileClick={() => onFileOpen?.(contentProps.filePath)}
            />
            </LazyToolFamily>
          );
        }
        break;

      case 'patch':
        contentComponent = <LazyToolFamily><ApplyPatchDisplay patchText={contentProps.patchText || ''} /></LazyToolFamily>;
        break;

      case 'markdown':
        contentComponent = <LazyToolFamily><MarkdownContent content={contentProps.content || ''} /></LazyToolFamily>;
        break;

      case 'file-list':
        contentComponent = (
          <FileListContent
            files={contentProps.files || []}
            onFileClick={onFileOpen}
            title={contentProps.title}
          />
        );
        break;

      case 'todo-list':
        if (contentProps.todos?.length > 0) {
          contentComponent = (
            <LazyToolFamily><TodoListContent
              todos={contentProps.todos}
              isResult={contentProps.isResult}
            /></LazyToolFamily>
          );
        }
        break;

      case 'task':
        contentComponent = <LazyToolFamily><TaskListContent content={contentProps.content || ''} /></LazyToolFamily>;
        break;

      case 'question-answer':
        contentComponent = (
          <LazyToolFamily><QuestionAnswerContent
            questions={contentProps.questions || []}
            answers={contentProps.answers || {}}
          /></LazyToolFamily>
        );
        break;

      case 'text':
        contentComponent = (
          <TextContent
            content={contentProps.content || ''}
            format={contentProps.format || 'plain'}
          />
        );
        break;

      case 'success-message': {
        const msg = displayConfig.getMessage?.(parsedData) || 'Success';
        contentComponent = (
          <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {msg}
          </div>
        );
        break;
      }
    }

    const handleTitleClick = (toolName === 'Edit' || toolName === 'Write' || toolName === 'ApplyPatch') && contentProps.filePath && onFileOpen
      ? () => onFileOpen(contentProps.filePath, {
          old_string: contentProps.oldContent,
          new_string: contentProps.newContent
        })
      : undefined;

    const badgeElement = toolStatus && toolStatus !== 'completed' ? <ToolStatusBadge status={toolStatus} /> : undefined;

    return (
      <CollapsibleDisplay
        toolName={toolName}
        toolId={toolId}
        title={title}
        defaultOpen={defaultOpen}
        onTitleClick={handleTitleClick}
        badge={badgeElement}
        showRawParameters={shouldShowRawParameters}
        rawContent={rawToolInput}
        toolCategory={getToolCategory(toolName)}
      >
        {contentComponent}
      </CollapsibleDisplay>
    );
  }

  return null;
});

ToolRenderer.displayName = 'ToolRenderer';
