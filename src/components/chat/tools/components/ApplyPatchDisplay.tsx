import React, { useMemo } from 'react';

import { parseApplyPatch, type PatchLineKind, type PatchOperation } from './applyPatchModel';

interface ApplyPatchDisplayProps {
  patchText: string;
}

const operationLabel: Record<PatchOperation, string> = {
  add: 'Added',
  update: 'Updated',
  delete: 'Deleted',
  move: 'Moved',
};

const rowClasses: Record<PatchLineKind, string> = {
  add: 'bg-green-50/50 text-green-800 dark:bg-green-950/20 dark:text-green-200',
  remove: 'bg-red-50/50 text-red-800 dark:bg-red-950/20 dark:text-red-200',
  context: 'text-gray-700 dark:text-gray-300',
};

export const ApplyPatchDisplay: React.FC<ApplyPatchDisplayProps> = ({ patchText }) => {
  const model = useMemo(() => parseApplyPatch(patchText), [patchText]);

  if (model.kind === 'fallback') {
    return (
      <pre className="max-w-full overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded border border-border/60 bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
        {model.content}
      </pre>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      {model.files.map((file, fileIndex) => (
        <div key={`${file.path}-${fileIndex}`} className="min-w-0 overflow-hidden rounded border border-gray-200/60 dark:border-gray-700/50">
          <div className="flex min-w-0 items-center justify-between border-b border-gray-200/60 bg-gray-50/80 px-2.5 py-1 dark:border-gray-700/50 dark:bg-gray-800/40">
            <span className="min-w-0 truncate font-mono text-[11px] text-gray-600 dark:text-gray-400">
              {file.path}{file.moveTo ? ` → ${file.moveTo}` : ''}
            </span>
            <span className="ml-2 flex-shrink-0 rounded bg-gray-100 px-1.5 py-px text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {operationLabel[file.operation]}
            </span>
          </div>
          <div className="min-w-0 font-mono text-[11px] leading-[18px]">
            {file.lines.map((line, lineIndex) => (
              <div key={lineIndex} className={`flex min-w-0 ${rowClasses[line.kind]}`}>
                <span className="w-8 flex-shrink-0 select-none border-r border-gray-200/50 pr-1 text-right text-gray-400 dark:border-gray-700/50 dark:text-gray-500">
                  {line.oldLine ?? ''}
                </span>
                <span className="w-8 flex-shrink-0 select-none border-r border-gray-200/50 pr-1 text-right text-gray-400 dark:border-gray-700/50 dark:text-gray-500">
                  {line.newLine ?? ''}
                </span>
                <span className="w-5 flex-shrink-0 select-none text-center">
                  {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2 [overflow-wrap:anywhere]">
                  {line.content}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
