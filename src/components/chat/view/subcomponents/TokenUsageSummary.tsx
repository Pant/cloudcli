import React from 'react';
import { ActivityIcon } from 'lucide-react';

import {
  buildTokenUsageBadgeState,
} from './TokenUsageSummary.utils';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

export default function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const summary = buildTokenUsageBadgeState(usage);

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={summary.title}
      aria-label={summary.ariaLabel}
    >
      <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      {!summary.hasCurrentWindow ? (
        <>
          <span className="shrink-0 font-medium text-muted-foreground/70">{summary.displayLabel}</span>
          <span className="hidden text-muted-foreground/70 sm:inline">current context unavailable</span>
        </>
      ) : (
        <>
          <span className="shrink-0 font-medium text-foreground">{summary.currentLabel}</span>
          {summary.maximumLabel && summary.percentageLabel ? (
            <span className="hidden min-w-0 truncate text-muted-foreground/70 sm:inline" aria-hidden="true">
              {' / '}{summary.maximumLabel}{' · '}{summary.percentageLabel}
            </span>
          ) : (
            <span className="hidden text-muted-foreground/70 sm:inline">tokens</span>
          )}
        </>
      )}
    </button>
  );
}
