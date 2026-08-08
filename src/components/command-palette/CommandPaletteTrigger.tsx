import { lazy, Suspense, useEffect, useState } from 'react';

import type { AppTab, Project } from '../../types/app';

import { isCommandPaletteShortcut } from './shortcut';

const CommandPalette = lazy(() => import('./CommandPalette'));

type CommandPaletteTriggerProps = {
  selectedProject: Project | null;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowTab?: (tab: AppTab) => void;
};

export default function CommandPaletteTrigger(props: CommandPaletteTriggerProps) {
  const [invoked, setInvoked] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isCommandPaletteShortcut(event)) return;
      event.preventDefault();
      setInvoked(true);
      setOpen((previous) => !previous);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!invoked) return null;

  return (
    <Suspense fallback={null}>
      <CommandPalette {...props} open={open} onOpenChange={setOpen} />
    </Suspense>
  );
}
