import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ProviderLoginModal from '../../provider-auth/view/ProviderLoginModal';
import { Button } from '../../../shared/view/ui';
import SettingsSidebar from '../view/SettingsSidebar';
import { useSettingsController } from '../hooks/useSettingsController';
import { useWebPush } from '../../../hooks/useWebPush';
import type { SettingsMainTab, SettingsProps } from '../types/types';

const settingsTabLoaders: Record<SettingsMainTab, () => Promise<unknown>> = {
  agents: () => import('../view/tabs/agents-settings/AgentsSettingsTab'), skills: () => import('../view/tabs/SkillsSettingsTab'),
  appearance: () => import('../view/tabs/AppearanceSettingsTab'), git: () => import('../view/tabs/git-settings/GitSettingsTab'),
  api: () => import('../view/tabs/api-settings/CredentialsSettingsTab'), voice: () => import('../view/tabs/VoiceSettingsTab'),
  browser: () => import('../view/tabs/browser-use-settings/BrowserUseSettingsTab'), plugins: () => import('../../plugins/view/PluginSettingsTab'),
  notifications: () => import('../view/tabs/NotificationsSettingsTab'), cache: () => import('../view/tabs/CacheSettingsTab'),
  'docker-management': () => import('../view/tabs/DockerManagementSettingsTab'), about: () => import('../view/tabs/AboutTab'),
};
const settingsWarmPromises = new Map<SettingsMainTab, Promise<unknown>>();
function warmSettingsTab(tab: SettingsMainTab) {
  const existing = settingsWarmPromises.get(tab);
  if (existing) return existing;
  const promise = settingsTabLoaders[tab]();
  settingsWarmPromises.set(tab, promise);
  return promise;
}

const AgentsSettingsTab = lazy(() => import('../view/tabs/agents-settings/AgentsSettingsTab'));
const SkillsSettingsTab = lazy(() => import('../view/tabs/SkillsSettingsTab'));
const AppearanceSettingsTab = lazy(() => import('../view/tabs/AppearanceSettingsTab'));
const CredentialsSettingsTab = lazy(() => import('../view/tabs/api-settings/CredentialsSettingsTab'));
const VoiceSettingsTab = lazy(() => import('../view/tabs/VoiceSettingsTab'));
const GitSettingsTab = lazy(() => import('../view/tabs/git-settings/GitSettingsTab'));
const BrowserUseSettingsTab = lazy(() => import('../view/tabs/browser-use-settings/BrowserUseSettingsTab'));
const NotificationsSettingsTab = lazy(() => import('../view/tabs/NotificationsSettingsTab'));
const PluginSettingsTab = lazy(() => import('../../plugins/view/PluginSettingsTab'));
const AboutTab = lazy(() => import('../view/tabs/AboutTab'));
const CacheSettingsTab = lazy(() => import('../view/tabs/CacheSettingsTab'));
const DockerManagementSettingsTab = lazy(() => import('../view/tabs/DockerManagementSettingsTab'));

type DesktopNotificationsState = {
  enabled: boolean;
  supported: boolean;
  connectedCount?: number;
  targetCount?: number;
  lastError?: string | null;
};

function SettingsContent({ isOpen, onClose, projects = [], initialTab = 'agents' }: SettingsProps) {
  const { t } = useTranslation('settings');
  const desktopNotificationsBridge = useMemo(() => (
    typeof window === 'undefined'
      ? null
      : ((window as any).cloudcliDesktopNotifications || null)
  ), []);
  const [desktopNotificationsState, setDesktopNotificationsState] = useState<DesktopNotificationsState | null>(null);
  const {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    notificationPreferences,
    setNotificationPreferences,
    cursorPermissions,
    setCursorPermissions,
    codexPermissionMode,
    setCodexPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  } = useSettingsController({
    isOpen,
    initialTab
  });

  const {
    permission: pushPermission,
    isSubscribed: isPushSubscribed,
    isLoading: isPushLoading,
    subscribe: pushSubscribe,
    unsubscribe: pushUnsubscribe,
  } = useWebPush();

  const handleEnablePush = async () => {
    const result = await pushSubscribe();
    if (!result.success) return;
    // Server sets webPush: true in preferences on subscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: true },
    });
  };

  const handleDisablePush = async () => {
    const result = await pushUnsubscribe();
    if (!result.success) return;
    // Server sets webPush: false in preferences on unsubscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: false },
    });
  };

  useEffect(() => {
    if (!desktopNotificationsBridge) return undefined;
    let mounted = true;
    desktopNotificationsBridge.getState().then((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    }).catch(() => {});
    const unsubscribe = desktopNotificationsBridge.onStateUpdated?.((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [desktopNotificationsBridge]);

  const handleEnableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: true });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: true },
    });
  };

  const handleDisableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: false });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: false },
    });
  };

  if (!isOpen) {
    return null;
  }

  const isAuthenticated = Boolean(loginProvider && providerAuthStatus[loginProvider].authenticated);

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-4">
      <div className="flex h-full w-full flex-col overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-4xl md:rounded-xl">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3 md:px-5">
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <div className="flex items-center gap-2">
            {saveStatus === 'success' && (
              <span className="animate-in fade-in text-xs text-muted-foreground">{t('saveStatus.success')}</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-10 w-10 touch-manipulation p-0 text-muted-foreground hover:text-foreground active:bg-accent/50"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <SettingsSidebar activeTab={activeTab} onChange={(tab) => { void warmSettingsTab(tab); setActiveTab(tab); }} />

          {/* Content */}
          <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            <Suspense fallback={<div className="flex min-h-40 items-center justify-center" role="status"><div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" /></div>}>
            <div key={activeTab} className="settings-content-enter min-w-0 space-y-6 overflow-x-hidden p-4 pb-safe-area-inset-bottom md:space-y-8 md:p-6">
              {activeTab === 'appearance' && (
                <AppearanceSettingsTab
                  projectSortOrder={projectSortOrder}
                  onProjectSortOrderChange={setProjectSortOrder}
                  codeEditorSettings={codeEditorSettings}
                  onCodeEditorWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                  onCodeEditorShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                  onCodeEditorLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                  onCodeEditorFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
                />
              )}

              {activeTab === 'git' && <GitSettingsTab />}

              {activeTab === 'agents' && (
                <AgentsSettingsTab
                  providerAuthStatus={providerAuthStatus}
                  onProviderLogin={openLoginForProvider}
                  claudePermissions={claudePermissions}
                  onClaudePermissionsChange={setClaudePermissions}
                  cursorPermissions={cursorPermissions}
                  onCursorPermissionsChange={setCursorPermissions}
                  codexPermissionMode={codexPermissionMode}
                  onCodexPermissionModeChange={setCodexPermissionMode}
                  projects={projects}
                />
              )}

              {activeTab === 'skills' && <SkillsSettingsTab projects={projects} />}

              {activeTab === 'browser' && <BrowserUseSettingsTab />}

              {activeTab === 'notifications' && (
                <NotificationsSettingsTab
                  notificationPreferences={notificationPreferences}
                  onNotificationPreferencesChange={setNotificationPreferences}
                  pushPermission={pushPermission}
                  isPushSubscribed={isPushSubscribed}
                  isPushLoading={isPushLoading}
                  onEnablePush={handleEnablePush}
                  onDisablePush={handleDisablePush}
                  isDesktop={Boolean(desktopNotificationsBridge)}
                  desktopNotifications={desktopNotificationsState}
                  onEnableDesktopNotifications={handleEnableDesktopNotifications}
                  onDisableDesktopNotifications={handleDisableDesktopNotifications}
                />
              )}

              {activeTab === 'api' && <CredentialsSettingsTab />}

              {activeTab === 'voice' && <VoiceSettingsTab />}

              {activeTab === 'plugins' && <PluginSettingsTab />}

              {activeTab === 'cache' && <CacheSettingsTab />}

              {activeTab === 'docker-management' && <DockerManagementSettingsTab />}

              {activeTab === 'about' && <AboutTab />}
            </div>
            </Suspense>
          </main>
        </div>
      </div>

      <ProviderLoginModal
        key={loginProvider || 'claude'}
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        provider={loginProvider || 'claude'}
        onComplete={handleLoginComplete}
        isAuthenticated={isAuthenticated}
      />

    </div>
  );
}

function Settings(props: SettingsProps) {
  if (!props.isOpen) return null;

  return (
    <Suspense fallback={<div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80" role="status"><div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" /></div>}>
      <SettingsContent {...props} />
    </Suspense>
  );
}

export default Settings;
