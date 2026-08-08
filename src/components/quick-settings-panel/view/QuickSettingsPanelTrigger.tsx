import { lazy, Suspense, useCallback, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useQuickSettingsDrag } from '../hooks/useQuickSettingsDrag';

import QuickSettingsHandle from './QuickSettingsHandle';

const QuickSettingsPanelView = lazy(() => import('./QuickSettingsPanelView'));

export default function QuickSettingsPanelTrigger() {
  const [invoked, setInvoked] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { isDragging, handleStyle, startDrag, consumeSuppressedClick } = useQuickSettingsDrag({ isMobile });

  const handleToggle = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (consumeSuppressedClick()) {
      event.preventDefault();
      return;
    }
    setInvoked(true);
    setIsOpen((previous) => !previous);
  }, [consumeSuppressedClick]);

  return (
    <>
      <QuickSettingsHandle
        isOpen={isOpen}
        isDragging={isDragging}
        style={handleStyle}
        onClick={handleToggle}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
      />
      {invoked && (
        <Suspense fallback={null}>
          <QuickSettingsPanelView isOpen={isOpen} onClose={() => setIsOpen(false)} isMobile={isMobile} />
        </Suspense>
      )}
    </>
  );
}
