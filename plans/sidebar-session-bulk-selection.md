# CONTEXT

The left sidebar is a React/TypeScript component tree driven by `useSidebarController`; active projects render their loaded session rows beneath each project, and the existing single-session confirmation already offers archive and permanent-delete choices through the provider session DELETE endpoint. The requested feature is frontend-only because the existing API can archive or permanently delete each session by ID, so bulk behavior can coordinate those existing mutations and refresh sidebar/archive state afterward. Selection mode should apply to active session rows rather than projects, make a normal session click toggle membership instead of navigating or expanding a branch, expose a per-project Select All control beside a bulk trash action, and retain the existing protection that prevents destructive actions for currently processing sessions. “Select All” necessarily targets the sessions currently loaded for that project because paginated sessions that have not been fetched have no client-side IDs.

## FILES

./src/components/sidebar/hooks/useSidebarController.ts - Owns sidebar UI state, session click behavior, archive/delete requests, refreshes, and the state/actions that must power bulk selection.
./src/components/sidebar/types/types.ts - Defines sidebar confirmation payloads and shared selection-related types used across the controller and modal components.
./src/components/sidebar/view/Sidebar.tsx - Connects controller state and actions to the header, project list, and modal surfaces.
./src/components/sidebar/view/subcomponents/SidebarContent.tsx - Passes top-level sidebar controls into the header and renders the active project list.
./src/components/sidebar/view/subcomponents/SidebarHeader.tsx - Renders desktop and mobile top-bar actions where the new selection-mode icon belongs immediately before refresh.
./src/components/sidebar/view/subcomponents/SidebarProjectList.tsx - Distributes selection-mode state and callbacks to every active project item.
./src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx - Connects per-project selection controls to the expanded session list.
./src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx - Renders the per-project Select All and trash controls and supplies each session row with selection state.
./src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx - Implements row-level selection visuals and changes click interpretation while selection mode is enabled.
./src/components/sidebar/view/subcomponents/SidebarModals.tsx - Hosts the existing archive/delete confirmation pattern and must present the selected-session count and bulk action choices.
./src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx - Covers server-rendered sidebar session hierarchy and source-level interaction contracts and can validate selection controls and click semantics.
./src/i18n/locales/en/sidebar.json - Provides the canonical English labels, tooltips, counts, and confirmation copy for session selection and bulk actions.
src/i18n/locales/de/sidebar.json - German sidebar translations must receive matching keys or safe localized/default copy.
src/i18n/locales/fr/sidebar.json - French sidebar translations must receive matching keys or safe localized/default copy.
src/i18n/locales/it/sidebar.json - Italian sidebar translations must receive matching keys or safe localized/default copy.
src/i18n/locales/ja/sidebar.json - Japanese sidebar translations must receive matching keys or safe localized/default copy.
src/i18n/locales/ko/sidebar.json - Korean sidebar translations must receive matching keys or safe localized/default copy.
src/i18n/locales/ru/sidebar.json - Russian sidebar translations must receive matching keys or safe localized/default copy.
src/i18n/locales/tr/sidebar.json - Turkish sidebar translations must receive matching keys or safe localized/default copy.
src/i18n/locales/zh-CN/sidebar.json - Simplified Chinese sidebar translations must receive matching keys or safe localized/default copy.
src/i18n/locales/zh-TW/sidebar.json - Traditional Chinese sidebar translations must receive matching keys or safe localized/default copy.
src/utils/apiClient.ts - Existing `deleteSession(sessionId, hardDelete)` behavior is the client contract reused for each selected session.
server/modules/providers/services/sessions.service.ts - Existing backend semantics confirm soft deletion archives a session and force deletion permanently removes it.

# ANALYSIS

The feature crosses the sidebar’s state, interaction, presentation, and confirmation layers. A dedicated selection-mode boolean and selected-session-ID set should live in the controller so the header toggle, every project list, and the bulk modal remain synchronized. Entering selection mode should keep project expansion and project controls usable, but session-row primary clicks must only toggle selection; anchor default navigation and branch toggling must not run. Exiting selection mode should clear the selection to avoid stale destructive state. Selection should also be pruned when projects refresh so IDs that disappear from the active list cannot remain actionable.

Each expanded project should reveal a compact action row containing Select All and a trash button. Select All should select all currently loaded, non-processing sessions in that project, or clear that project’s selected IDs when all eligible sessions are already selected. The trash button should be disabled when that project contributes no selected sessions and should open one bulk confirmation for the overall selected set; this preserves the user’s wording that the action is adjacent to Select All while allowing selections across multiple projects. Session rows need an accessible checkbox-like indicator and selected styling on both mobile and desktop, while rename/options/start controls should not accidentally perform navigation.

The confirmation should report the number of selected sessions and offer Archive selected, Delete permanently, and Cancel. Bulk execution should use the established API for every selected ID, tolerate and report partial failure rather than hiding it, notify the parent for each successful ID so local active-session state is reconciled, then refresh active and archived data. Destructive controls should be disabled during execution to prevent duplicate requests. No backend route is required, avoiding an unnecessary new bulk API and preserving current provider-specific deletion semantics. Focused tests should validate the rendered project controls, selected row semantics, and that selection-mode row clicks replace navigation/branch behavior; frontend typecheck, focused frontend tests, and lint on touched source files are required.

# PLAN

1. Add controller-owned session selection mode, selected-ID bookkeeping, project-level select-all behavior, and bulk archive/permanent-delete execution using the existing per-session API.
2. Thread the state through the sidebar tree, add the top select toggle, per-project Select All/trash controls, selectable session-row visuals and semantics, and a bulk confirmation modal with busy/error-safe behavior.
3. Add focused frontend coverage and complete the sidebar locale keys across supported languages.

# GUIDELINES

- Keep this frontend-only and reuse `apiClient.deleteSession`; do not add or modify backend routes or services.
- Selection is session-only: project-row clicks keep their existing select/expand behavior, while active session-row clicks toggle selection whenever selection mode is on.
- Entering selection mode starts with no selected sessions, and leaving it or completing a bulk action clears the selection and closes any bulk confirmation.
- Select All operates on currently loaded active sessions for that project and excludes sessions present in `activeSessions`; if every eligible loaded session is selected, the same control deselects that project’s eligible sessions.
- Preserve nested-session disclosure controls, keyboard/modifier navigation outside selection mode, active/attention/lifecycle indicators, mobile layouts, and existing single-session archive/delete flows.
- Show an accessible checkbox-style selection indicator on session rows, expose `aria-pressed`/labels on mode and project controls, and visibly distinguish selected rows in both responsive layouts.
- Bulk archive/permanent-delete must prevent duplicate submissions, call `onSessionDelete` for every successful mutation, refresh active and archived data after the batch, retain/report failed selections, and alert with localized partial/all-failure copy.
- Use i18n keys under a coherent `selection` namespace and avoid introducing hard-coded user-facing selection strings in React components.
- Do not modify Git state or perform any VCS operation.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Implement active-session selection mode, project-level selection actions, selectable row behavior, and bulk archive/permanent-delete confirmation and execution throughout the sidebar.
  **Files:**
  ./src/components/sidebar/hooks/useSidebarController.ts - Add selection state, pruning, click interpretation, select-all toggles, confirmation state, and resilient bulk mutation execution.
  ./src/components/sidebar/types/types.ts - Define the bulk confirmation payload and any shared selection types required by the sidebar tree.
  ./src/components/sidebar/view/Sidebar.tsx - Wire controller selection state/actions into content, project list props, and modals.
  ./src/components/sidebar/view/subcomponents/SidebarContent.tsx - Pass selection controls to the header while preserving current active/search/archive rendering.
  ./src/components/sidebar/view/subcomponents/SidebarHeader.tsx - Add accessible desktop and mobile selection-mode buttons immediately before refresh.
  ./src/components/sidebar/view/subcomponents/SidebarProjectList.tsx - Forward selection mode, selected IDs, processing eligibility, and project actions to project items.
  ./src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx - Connect selection props to expanded project sessions without changing project selection semantics.
  ./src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx - Render Select All and trash controls per expanded project and compute eligible/selected project session state.
  ./src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx - Render selected indicators and make primary clicks toggle selection instead of navigating or expanding during selection mode.
  ./src/components/sidebar/view/subcomponents/SidebarModals.tsx - Add the selected-session archive/permanent-delete confirmation with a busy state and localized count/copy.
  ./src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx - Add focused rendering and source-contract coverage for selection controls and click semantics.
  ./src/i18n/locales/en/sidebar.json - Add canonical English selection labels, tooltips, count copy, actions, and failure messages.
  **Acceptance criteria:** A select icon appears immediately left of refresh on desktop and mobile; toggling it enables/disables session selection and clears stale selections; clicking active session rows in selection mode toggles only that session and does not navigate or expand branches; each expanded project shows Select All and a trash action; Select All toggles all currently loaded non-processing sessions for that project; selected rows are accessible and visibly marked; trash opens one confirmation showing the selected count with Archive selected, Delete permanently, and Cancel; bulk actions use existing session APIs, block duplicate submission, reconcile successful IDs, refresh sidebar/archive data, and retain/report failures; all pre-existing non-selection behavior remains intact.
  **Validation:** Add and run focused `SidebarProjectSessions.test.tsx` coverage for project controls, selected row markup, and selection-mode click contracts; run `npm run typecheck:frontend`; run ESLint with zero warnings on all touched `src/components/sidebar` TypeScript/TSX files.
  **Summary:** Added controller-owned selection state, pruning, project select-all, resilient bulk archive/delete execution, complete sidebar/header/tree/modal wiring, accessible selected-row UI, canonical English selection keys, and focused tests. Validation passed: focused node test (9/9), `npm run typecheck:frontend`, and ESLint with zero warnings on all touched sidebar TS/TSX files. Unexpected: TODO 2 was concurrently marked in progress and was left unchanged.

- [x] **ID:** 2 | **Batch:** 1
  **Task:** Localize the new session-selection and bulk-action strings in every non-English sidebar locale using the exact key structure introduced by TODO 1.
  **Files:**
  ./src/i18n/locales/de/sidebar.json - Add German selection-mode, Select All, bulk confirmation, action, and failure strings.
  ./src/i18n/locales/fr/sidebar.json - Add French selection-mode, Select All, bulk confirmation, action, and failure strings.
  ./src/i18n/locales/it/sidebar.json - Add Italian selection-mode, Select All, bulk confirmation, action, and failure strings.
  ./src/i18n/locales/ja/sidebar.json - Add Japanese selection-mode, Select All, bulk confirmation, action, and failure strings.
  ./src/i18n/locales/ko/sidebar.json - Add Korean selection-mode, Select All, bulk confirmation, action, and failure strings.
  ./src/i18n/locales/ru/sidebar.json - Add Russian selection-mode, Select All, bulk confirmation, action, and failure strings.
  ./src/i18n/locales/tr/sidebar.json - Add Turkish selection-mode, Select All, bulk confirmation, action, and failure strings.
  ./src/i18n/locales/zh-CN/sidebar.json - Add Simplified Chinese selection-mode, Select All, bulk confirmation, action, and failure strings.
  ./src/i18n/locales/zh-TW/sidebar.json - Add Traditional Chinese selection-mode, Select All, bulk confirmation, action, and failure strings.
  **Acceptance criteria:** Every supported non-English sidebar locale contains the same new `selection` key structure as English; values are valid JSON strings with appropriate plural/count interpolation where the locale already uses i18next plural forms; no unrelated locale content is changed.
  **Validation:** Parse all touched locale files as JSON and compare their new `selection` key paths against `src/i18n/locales/en/sidebar.json`; run `npm run typecheck:frontend` if TypeScript-based locale imports expose any issue.
  **Summary:** Added the canonical `selection` namespace with natural localized strings to German, French, Italian, Japanese, Korean, Russian, Turkish, Simplified Chinese, and Traditional Chinese sidebar JSON files. Validation passed by parsing every touched file and comparing selection keys and interpolation variables with English; no TypeScript locale-import issue was exposed, so frontend typecheck was not required. Unexpected: the canonical English namespace appeared after the task began, as anticipated for concurrent TODO 1.

# CHANGELOG
- TODO 1: Implemented active-session bulk selection across controller, sidebar views, confirmation modal, English i18n, and focused tests; typecheck, 9 focused tests, and zero-warning ESLint all passed.
- TODO 2: Localized the canonical selection namespace in all nine non-English sidebar locales; JSON parsing, key-path parity, and interpolation-variable validation passed.
