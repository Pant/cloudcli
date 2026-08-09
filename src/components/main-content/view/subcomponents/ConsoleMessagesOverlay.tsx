import * as React from 'react';
import { X } from 'lucide-react';

import type { ConsoleCaptureEntry, ConsoleLevel } from '../../../../lib/consoleCapture';
import { getConsoleMessagesSnapshot, subscribeToConsoleMessages } from '../../../../lib/consoleCapture';
import { Button, Dialog, DialogContent, DialogTitle, ScrollArea } from '../../../../shared/view/ui';

interface ConsoleMessagesOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const levelStyles: Record<ConsoleLevel, string> = {
  debug: 'text-muted-foreground',
  log: 'text-foreground',
  info: 'text-blue-600 dark:text-blue-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
};

export function ConsoleMessagesList({ entries }: { entries: readonly ConsoleCaptureEntry[] }) {
  if (entries.length === 0) {
    return <p className="p-6 text-center text-sm text-muted-foreground">No console messages captured yet.</p>;
  }

  return (
    <ol className="divide-y font-mono text-xs" aria-label="Captured console messages">
      {entries.map(entry => (
        <li key={entry.id} className="grid grid-cols-[auto_auto_1fr] items-start gap-3 px-4 py-2">
          <time dateTime={entry.timestamp} className="whitespace-nowrap text-muted-foreground">
            {new Date(entry.timestamp).toLocaleTimeString()}
          </time>
          <span className={`w-12 font-semibold uppercase ${levelStyles[entry.level]}`}>{entry.level}</span>
          <pre className="m-0 whitespace-pre-wrap break-words font-inherit">{entry.text}</pre>
        </li>
      ))}
    </ol>
  );
}

export function ConsoleMessagesOverlay({ open, onOpenChange }: ConsoleMessagesOverlayProps) {
  const entries = React.useSyncExternalStore(
    subscribeToConsoleMessages,
    getConsoleMessagesSnapshot,
    getConsoleMessagesSnapshot,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-labelledby="console-messages-title" className="flex h-[min(80vh,48rem)] max-w-5xl flex-col p-0">
        <header className="flex items-center justify-between border-b px-4 py-3">
          <DialogTitle id="console-messages-title" className="not-sr-only text-base font-semibold">
            Console messages
          </DialogTitle>
          <Button type="button" variant="ghost" size="icon" aria-label="Close console messages" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <ConsoleMessagesList entries={entries} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
