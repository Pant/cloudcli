import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCw, Terminal } from 'lucide-react';

import type { MainContentHeaderProps } from '../../types/types';
import { getConsoleMessagesSnapshot, subscribeToConsoleMessages } from '../../../../lib/consoleCapture';
import { Button } from '../../../../shared/view/ui';

import { ConsoleMessagesOverlay } from './ConsoleMessagesOverlay';
import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';

export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowBrowserTab,
  isMobile,
  onMenuClick,
}: MainContentHeaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const consoleMessages = useSyncExternalStore(
    subscribeToConsoleMessages,
    getConsoleMessagesSnapshot,
    getConsoleMessagesSnapshot,
  );
  const consoleLabel = `Open console messages (${consoleMessages.length} captured)`;

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState]);

  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <MainContentTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
          />
        </div>

        <div className="flex min-w-0 flex-shrink items-center">
          <div className="relative min-w-0 flex-shrink overflow-hidden sm:flex-shrink-0">
            {canScrollLeft && (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
            )}
            <div
              ref={scrollRef}
              onScroll={updateScrollState}
              className="scrollbar-hide overflow-x-auto"
            >
              <MainContentTabSwitcher
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                shouldShowBrowserTab={shouldShowBrowserTab}
              />
            </div>
            {canScrollRight && (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="relative ml-1 h-7 w-7 flex-shrink-0 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
            onClick={() => setIsConsoleOpen(true)}
            aria-label={consoleLabel}
            title={consoleLabel}
          >
            <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-1 h-7 w-7 flex-shrink-0 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
            onClick={() => window.location.reload()}
            aria-label="Reload page"
            title="Reload page"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <ConsoleMessagesOverlay open={isConsoleOpen} onOpenChange={setIsConsoleOpen} />
    </div>
  );
}
