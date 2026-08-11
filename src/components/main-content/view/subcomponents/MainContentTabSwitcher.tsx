import { MessageSquare, Terminal, Folder, GitBranch, MonitorPlay, BookOpen, type LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import type { AppTab } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/plugins';
import PluginIcon from '../../../plugins/view/PluginIcon';

const featureLoaders: Partial<Record<AppTab, () => Promise<unknown>>> = {
  chat: () => import('../../../chat/view/ChatInterface'),
  shell: () => import('../../../standalone-shell/view/StandaloneShell'),
  files: () => import('../../../file-tree/view/FileTree'),
  git: () => import('../../../git-panel/view/GitPanel'),
  docs: () => import('../../../docs-ui/view/DocsUiPanel'),
  browser: () => import('../../../browser-use/view/BrowserUsePanel'),
};
const featureWarmPromises = new Map<AppTab, Promise<unknown>>();

function warmMainContentFeature(tab: AppTab) {
  const loader = featureLoaders[tab];
  if (!loader) return undefined;
  const existing = featureWarmPromises.get(tab);
  if (existing) return existing;
  const promise = loader();
  featureWarmPromises.set(tab, promise);
  return promise;
}

type MainContentTabSwitcherProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowBrowserTab: boolean;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

type TabDefinition = BuiltInTab | PluginTab;

const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
  { kind: 'builtin', id: 'docs',  labelKey: 'tabs.docs',  icon: BookOpen },
];

const BROWSER_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'browser',
  labelKey: 'tabs.browser',
  icon: MonitorPlay,
};

export default function MainContentTabSwitcher({
  activeTab,
  setActiveTab,
  shouldShowBrowserTab,
}: MainContentTabSwitcherProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const builtInTabs: BuiltInTab[] = [
    ...BASE_TABS,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
  ];

  const pluginTabs: PluginTab[] = plugins
    .filter((p) => p.enabled)
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}` as AppTab,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
    }));

  const tabs: TabDefinition[] = [...builtInTabs, ...pluginTabs];

  return (
    <PillBar>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const displayLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;

        return (
          <Tooltip key={tab.id} content={displayLabel} position="bottom">
            <div onPointerEnter={() => { void warmMainContentFeature(tab.id); }} onFocus={() => { void warmMainContentFeature(tab.id); }}>
            <Pill
              isActive={isActive}
              onClick={() => { void warmMainContentFeature(tab.id); setActiveTab(tab.id); }}
              className="px-2.5 py-[5px]"
            >
              {tab.kind === 'builtin' ? (
                <tab.icon className="h-3.5 w-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
              ) : (
                <PluginIcon
                  pluginName={tab.pluginName}
                  iconFile={tab.iconFile}
                  className="flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                />
              )}
              <span className="hidden lg:inline">{displayLabel}</span>
            </Pill>
            </div>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
