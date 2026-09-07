# Frontend Settings, Plugins, and Onboarding

## Scope and boundaries

This map covers frontend configuration surfaces: the full settings dialog, quick preferences, provider CLI authentication, plugin management/runtime mounting, MCP and skill configuration, first-run onboarding, and project creation. Backend persistence and integration process ownership are outside this chapter; see `backend-persistence-automation-integrations.md`. General application provider/layout composition belongs in `frontend-app-shell-navigation.md`, and transport contracts belong in `shared-contracts-api-transport.md`.

## Configuration surface composition

```mermaid
flowchart LR
  Settings[Settings] --> Controller[useSettingsController]
  Settings --> Sidebar[SettingsSidebar / NAV_ITEMS]
  Settings --> Lazy[settingsTabLoaders + React.lazy tabs]
  Controller --> Local[localStorage]
  Controller --> API[/api/settings/*]
  Agents[AgentsSettingsTab] --> Categories[AgentCategoryContentSection]
  Categories --> Auth[provider account/login]
  Categories --> MCP[McpServers]
  Categories --> ProviderSkills[ProviderSkills]
  Quick[QuickSettingsPanelView] --> Prefs[useUiPreferences]
  Prefs --> Unified[localStorage uiPreferences + sync events]
```

### Settings registration pattern

Settings tabs are registered through several compile-time lists rather than a dynamic registry. A new main tab normally requires coordinated changes to:

1. `SettingsMainTab` in `src/components/settings/types/types.ts` (accepted identifier).
2. `NAV_ITEMS` in `src/components/settings/view/SettingsSidebar.tsx` (desktop/mobile navigation).
3. `settingsTabLoaders`, a `lazy(...)` component, and the `activeTab` render branch in `src/components/settings/view/Settings.tsx` (warming, code splitting, composition).
4. `KNOWN_MAIN_TABS` and `normalizeMainTab` in `src/components/settings/hooks/useSettingsController.ts` (valid `initialTab` handling).
5. Where searchable metadata is used, `SETTINGS_MAIN_TABS` in `src/components/settings/constants/constants.ts`.

Registration tests such as `settingsCacheRegistration.test.ts`, `settingsDockerManagementRegistration.test.ts`, and `settingsSkillsRegistration.test.ts` guard this multi-list pattern. The lists are not perfectly identical: for example, `voice` is in the type/sidebar/rendering but not currently in `KNOWN_MAIN_TABS` or `SETTINGS_MAIN_TABS`; inspect every list rather than treating one as authoritative.

Within the Agents tab, `AGENT_PROVIDERS` and `AGENT_CATEGORIES` in `settings/constants/constants.ts` seed provider/category choices, while `AgentCategoryContentSection` performs category/provider dispatch. It mounts account and permission content, `McpServers`, `ProviderSkills`, or `OpenCodeAgentsContent` according to the selected combination.

## Important symbols

### Settings and quick settings

| Symbol | Defining path | Role |
|---|---|---|
| `Settings`, `SettingsContent` | `src/components/settings/view/Settings.tsx` | Modal boundary and active-tab composition; lazily loads heavyweight tabs and owns provider-login modal placement. |
| `settingsTabLoaders`, `warmSettingsTab` | `src/components/settings/view/Settings.tsx` | Map tab IDs to dynamic imports and prewarm a selected tab before rendering it. |
| `SettingsSidebar`, `NAV_ITEMS` | `src/components/settings/view/SettingsSidebar.tsx` | Desktop and mobile navigation registration. |
| `useSettingsController` | `src/components/settings/hooks/useSettingsController.ts` | Loads, normalizes, updates, and debounced-saves shared settings state; coordinates provider status/login state. |
| `KNOWN_MAIN_TABS`, `normalizeMainTab` | `src/components/settings/hooks/useSettingsController.ts` | Validate externally supplied initial tabs and retain the legacy `tools` alias. |
| `SETTINGS_MAIN_TABS`, `AGENT_PROVIDERS`, `AGENT_CATEGORIES` | `src/components/settings/constants/constants.ts` | Search/display metadata and Agents-tab provider/category registration. |
| `AgentCategoryContentSection` | `src/components/settings/view/tabs/agents-settings/sections/AgentCategoryContentSection.tsx` | Provider/category switchboard for account, permissions, MCP, provider skills, and OpenCode agent configuration. |
| `QuickSettingsPanelView` | `src/components/quick-settings-panel/view/QuickSettingsPanelView.tsx` | Adapts shared UI preferences to the slide-out panel. |
| `QuickSettingsContent` | `src/components/quick-settings-panel/view/QuickSettingsContent.tsx` | Composes appearance, tool-display, and input sections from toggle metadata. |
| `TOOL_DISPLAY_TOGGLES`, `INPUT_SETTING_TOGGLES` | `src/components/quick-settings-panel/constants.ts` | Declarative registration of quick preference rows. |
| `useUiPreferences` | `src/hooks/useUiPreferences.ts` | Reducer-backed boolean preferences, unified storage migration, and same-tab/cross-tab synchronization. |

### Providers and plugins

| Symbol | Defining path | Role |
|---|---|---|
| `useProviderAuthStatus` | `src/components/provider-auth/hooks/useProviderAuthStatus.ts` | Maintains per-provider loading/auth/error state and queries provider-specific status endpoints. |
| `ProviderLoginModal` | `src/components/provider-auth/view/ProviderLoginModal.tsx` | Runs the provider login command in lazy `StandaloneShell`; reports process exit without automatically closing. |
| `CLI_PROVIDERS`, `PROVIDER_AUTH_STATUS_ENDPOINTS` | `src/components/provider-auth/types.ts` | Provider status registration and initial status-map inputs. |
| `Plugin`, `PluginsContextValue`, `usePlugins` | `src/contexts/plugins.ts` | Frontend plugin contract and guarded context consumer. |
| `PluginsProvider`, `getPluginsOwner` | `src/contexts/PluginsContext.tsx` | Shared cached plugin list owner plus install/uninstall/update/enable mutations. |
| `PluginSettingsTab` | `src/components/plugins/view/PluginSettingsTab.tsx` | Plugin marketplace/management UI consuming context lifecycle methods. |
| `PluginTabContent` | `src/components/plugins/view/PluginTabContent.tsx` | Authenticated plugin asset loading, dynamic module mount/unmount, context updates, and plugin RPC bridge. |

### MCP and skills

| Symbol | Defining path | Role |
|---|---|---|
| `McpServers` | `src/components/mcp/view/McpServers.tsx` | Provider-aware MCP list, scope controls, forms, and mutation UI. |
| `useMcpServers`, `createMcpTogglePayload` | `src/components/mcp/hooks/useMcpServers.ts` | Loads cached user/project MCP scopes and performs create/edit/delete/toggle operations. |
| `useMcpServerForm` | `src/components/mcp/hooks/useMcpServerForm.ts` | Form state, validation, and JSON/form import handling. |
| `McpProvider`, `McpScope`, `ProviderMcpServer`, `McpProject` | `src/components/mcp/types.ts` | Core provider/scope/server/project shapes. |
| `ProviderSkills` | `src/components/skills/view/ProviderSkills.tsx` | Provider-specific skill discovery, creation/access, scope, and project UI. |
| `useProviderSkills`, `updateProviderSkillAccess` | `src/components/skills/hooks/useProviderSkills.ts` | Provider skill loading/cache and access mutation. |
| `fetchOpenCodeSkills`, `mutateOpenCodeSkillAccess`, `createProjectTargets` | `src/components/skills/hooks/useProviderSkills.ts` | OpenCode-specific global/project skill operations reused by `SkillsSettingsTab`. |
| `SkillsSettingsTab` | `src/components/settings/view/tabs/SkillsSettingsTab.tsx` | Dedicated OpenCode skill access surface, separate from provider-category skills. |
| `ProviderSkill`, `SkillsScope`, `SkillsProject` | `src/components/skills/types.ts` | Skill identity, origin/scope, enabled state, and project target shapes. |

### Onboarding and project creation

| Symbol | Defining path | Role |
|---|---|---|
| `Onboarding` | `src/components/onboarding/view/Onboarding.tsx` | Two-step first-run controller for Git identity and agent connections, then marks onboarding complete. |
| `GitConfigurationStep`, `AgentConnectionsStep`, `OnboardingStepProgress` | `src/components/onboarding/view/subcomponents/*` | Presentational step surfaces and progress UI. |
| `ProjectCreationWizard` | `src/components/project-creation-wizard/ProjectCreationWizard.tsx` | Owns cross-step form state and chooses plain project creation versus repository clone. |
| `useGithubTokens` | `src/components/project-creation-wizard/hooks/useGithubTokens.ts` | Conditionally loads stored GitHub credentials and auto-selects a usable token. |
| `createProjectRequest`, `cloneWorkspaceWithProgress` | `src/components/project-creation-wizard/data/workspaceApi.ts` | Plain create request and EventSource-based clone workflow with progress/complete/error events. |
| `browseFilesystemFolders`, `createFolderInFilesystem` | `src/components/project-creation-wizard/data/workspaceApi.ts` | Folder picker backend adapters. |
| `isCloneWorkflow`, `shouldShowGithubAuthentication` | `src/components/project-creation-wizard/utils/pathUtils.ts` | Determine workflow and credential visibility from repository input. |

## Persistence and lifecycle flows

### Settings persistence

- `useSettingsController.loadSettings` reads Claude, Cursor, Codex, sort, and editor preferences from `localStorage`; notification preferences come from `GET /api/settings/notification-preferences`.
- Permission/sort changes trigger `saveSettings` after a 500 ms debounce. It writes provider settings to local storage and sends notification preferences with `PUT /api/settings/notification-preferences`.
- Code-editor fields persist immediately to individual local-storage keys and emit `codeEditorSettingsChanged`.
- Specialized tabs may own separate API persistence; follow their hooks/services rather than assuming the controller saves all tabs.
- `useUiPreferences` stores one `uiPreferences` JSON object, migrates legacy per-key values, filters unknown keys, emits `ui-preferences:sync` for same-document consumers, and listens to both that event and browser `storage` events.
- Quick-settings handle position is distinct UI state stored under `HANDLE_POSITION_STORAGE_KEY` by `useQuickSettingsDrag`.

### Provider login flow

1. Settings opens and `useSettingsController` calls `refreshProviderAuthStatuses`; `useProviderAuthStatus` queries each `PROVIDER_AUTH_STATUS_ENDPOINTS` entry.
2. An account action calls `openLoginForProvider`, causing `Settings` to render `ProviderLoginModal`.
3. The modal maps the provider to a CLI login command and runs it in `StandaloneShell`.
4. Shell completion calls `handleLoginComplete`; the controller rechecks that provider and derives save success/error from observed authentication state, not merely exit code.

Onboarding reuses the same hook/modal. It refreshes all statuses on mount and after modal closure, saves Git identity through `/api/user/git-config`, then posts `/api/user/complete-onboarding`.

### Plugin lifecycle flow

1. `PluginsProvider` obtains a shared `KeyedServerState` owner; `refreshPlugins` reads `GET /api/plugins` with a five-second cache window.
2. `PluginSettingsTab` invokes `installPlugin`, `uninstallPlugin`, `updatePlugin`, or `togglePlugin`.
3. Successful mutations invalidate and force-read the shared plugin list, updating all `usePlugins` consumers.
4. For an enabled plugin tab, `PluginTabContent` fetches its entry asset with authentication, imports a temporary Blob URL, and calls optional `mount(container, api)`.
5. The API exposes current theme/project/session context, context-change subscription, and authenticated plugin RPC. Dependency changes or unmount call optional `unmount` and clear callbacks.

## Responsibility boundaries

- **Provider authentication:** CLI login/status only; account UI consumes it, while provider execution belongs to backend/provider maps.
- **Plugins:** installation and enabled-state management through context, plus runtime frontend module mounting and RPC. Plugin server processes are backend-owned.
- **MCP:** provider-scoped server definitions across user/local/project scopes; it is embedded under an Agents category, not a top-level settings tab.
- **Skills:** discovers and changes skill access/entries. `ProviderSkills` handles provider-category views; `SkillsSettingsTab` is the dedicated OpenCode global/project surface.
- **Onboarding:** first-run Git identity and provider connection guidance, ending with completion state; it does not create projects.
- **Project creation:** workspace path selection, optional GitHub authentication, create/clone requests, and clone progress; it does not configure provider accounts or global settings.

## Extension and change points

- Add a main settings surface only after updating every registration point listed above and adding a registration test.
- Add an Agents category by updating category types/constants, selector behavior, and `AgentCategoryContentSection` dispatch.
- Add a provider by coordinating provider types, status endpoint/initial-map registration, login command/title, Agents UI support, and MCP/skills capability constants.
- Extend quick preferences by adding the key/default to `useUiPreferences`, exposing it through quick-settings types/adaptation, and registering a toggle metadata item.
- Change plugin runtime capabilities in `PluginTabContent`'s `api` object; preserve authenticated asset/RPC boundaries and cleanup semantics.
- Change MCP or skill persistence in their hooks, where provider/scope API payloads and caches are centralized.
- Add wizard steps by extending `WizardStep`, retaining cross-step state in `ProjectCreationWizard`, and updating progress/footer/review components together.

## Focused validation references

- Settings registration: `src/components/settings/settingsCacheRegistration.test.ts`, `settingsDockerManagementRegistration.test.ts`, `settingsSkillsRegistration.test.ts`.
- MCP: `src/components/mcp/hooks/useMcpServers.test.ts`.
- Skills: `src/components/skills/hooks/useProviderSkills.test.ts`.
- Documentation validation: verify each cited symbol in its path; trace `Settings` → `SettingsSidebar`/lazy render → `useSettingsController`, and `PluginSettingsTab` → `PluginsProvider` mutation → forced refresh (or the provider login flow above).
