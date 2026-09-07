import * as React from 'react';
import { X } from 'lucide-react';

import type { ConsoleCaptureEntry, ConsoleLevel } from '../../../../lib/consoleCapture';
import { getConsoleMessagesSnapshot, subscribeToConsoleMessages } from '../../../../lib/consoleCapture';
import { captureClientPerformance, getLatestClientPerformanceReport } from '../../../../lib/performanceDiagnostics';
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

interface PerformanceCaptureControlsProps {
  isCapturing: boolean;
  hasReport: boolean;
  status: string;
  onStartCapture: () => void;
  onCopyReport: () => void;
}

export function PerformanceCaptureControls({
  isCapturing,
  hasReport,
  status,
  onStartCapture,
  onCopyReport,
}: PerformanceCaptureControlsProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <Button type="button" size="sm" disabled={isCapturing} onClick={onStartCapture}>
        {isCapturing ? 'Capturing performance…' : 'Start performance capture'}
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={!hasReport} onClick={onCopyReport}>
        Copy latest performance report
      </Button>
      <p className="min-w-48 flex-1 text-xs text-muted-foreground" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

export function ConsoleMessagesOverlay({ open, onOpenChange }: ConsoleMessagesOverlayProps) {
  const entries = React.useSyncExternalStore(
    subscribeToConsoleMessages,
    getConsoleMessagesSnapshot,
    getConsoleMessagesSnapshot,
  );
  const [isCapturing, setIsCapturing] = React.useState(false);
  const [latestReport, setLatestReport] = React.useState<string | null>(() => getLatestClientPerformanceReport());
  const [status, setStatus] = React.useState('Start a capture, reproduce the slowdown during the bounded window, then copy the latest report and paste it into support chat.');

  React.useEffect(() => {
    if (open) setLatestReport(getLatestClientPerformanceReport());
  }, [open]);

  const handleStartCapture = React.useCallback(() => {
    if (isCapturing) return;
    setIsCapturing(true);
    setStatus('Capture in progress. Reproduce the slowdown during this bounded window.');
    void captureClientPerformance()
      .then(report => {
        setLatestReport(report);
        setStatus('Capture complete. Copy the latest report and paste it into support chat.');
      })
      .catch(() => {
        setStatus('Performance capture failed. You can try starting another capture.');
      })
      .finally(() => setIsCapturing(false));
  }, [isCapturing]);

  const handleCopyReport = React.useCallback(() => {
    if (!latestReport) return;
    void navigator.clipboard.writeText(latestReport)
      .then(() => setStatus('Latest performance report copied. Paste it into support chat.'))
      .catch(() => setStatus('Could not copy the report. The latest report is still available; check clipboard permissions and try again.'));
  }, [latestReport]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-labelledby="console-messages-title" className="flex h-[min(80vh,48rem)] max-w-5xl flex-col p-0">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <DialogTitle id="console-messages-title" className="not-sr-only text-base font-semibold">
            Console messages
          </DialogTitle>
          <PerformanceCaptureControls
            isCapturing={isCapturing}
            hasReport={latestReport !== null}
            status={status}
            onStartCapture={handleStartCapture}
            onCopyReport={handleCopyReport}
          />
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
