import { useCallback, useMemo } from 'react';

import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useTheme } from '../../../contexts/useTheme';
import type { PreferenceToggleKey, QuickSettingsPreferences } from '../types';

import QuickSettingsContent from './QuickSettingsContent';
import QuickSettingsPanelHeader from './QuickSettingsPanelHeader';

export default function QuickSettingsPanelView({ isOpen, onClose, isMobile }: { isOpen: boolean; onClose: () => void; isMobile: boolean }) {
  const { isDarkMode } = useTheme();
  const { preferences, setPreference } = useUiPreferences();

  const quickSettingsPreferences = useMemo<QuickSettingsPreferences>(() => ({
    showRawParameters: preferences.showRawParameters,
    showThinking: preferences.showThinking,
    sendByCtrlEnter: preferences.sendByCtrlEnter,
    voiceEnabled: preferences.voiceEnabled,
  }), [
    preferences.sendByCtrlEnter,
    preferences.showRawParameters,
    preferences.showThinking,
    preferences.voiceEnabled,
  ]);

  const handlePreferenceChange = useCallback(
    (key: PreferenceToggleKey, value: boolean) => {
      setPreference(key, value);
    },
    [setPreference],
  );

  return (
    <>
      <div
        className={`fixed right-0 top-0 z-[9999] h-full w-64 transform border-l border-border bg-background shadow-xl transition-transform duration-150 ease-out ${isOpen ? 'translate-x-0' : 'translate-x-full'} ${isMobile ? 'h-screen' : ''}`}
      >
        <div className="flex h-full flex-col">
          <QuickSettingsPanelHeader />
          <QuickSettingsContent
            isDarkMode={isDarkMode}
            preferences={quickSettingsPreferences}
            onPreferenceChange={handlePreferenceChange}
          />
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-[9998] bg-background/80 backdrop-blur-sm transition-opacity duration-150 ease-out"
          onClick={onClose}
        />
      )}
    </>
  );
}
