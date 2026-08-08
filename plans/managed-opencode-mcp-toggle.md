# CONTEXT

## FILES

./server/shared/types.ts - Defines the normalized backend MCP server and upsert payload shapes shared by provider services and routes.
./server/modules/providers/shared/mcp/mcp.provider.ts - Implements common MCP list and upsert behavior, including replacement of provider-native server configuration.
./server/modules/providers/list/opencode/opencode-mcp.provider.ts - Maps OpenCode MCP entries to and from `opencode.json(c)`, where the native `enabled` field already exists.
./server/modules/providers/provider.routes.ts - Exposes provider MCP list and upsert endpoints and parses MCP payloads from the UI.
./server/modules/providers/tests/mcp.test.ts - Covers OpenCode MCP persistence, normalization, and service behavior.
./server/modules/browser-use/browser-use.service.ts - Reconciles the managed `cloudcli-browser` MCP registration at startup and whenever Browser settings are enabled.
./server/modules/browser-use/tests/browser-use.service.test.ts - Verifies startup reconciliation of the managed Browser MCP in OpenCode.
./src/components/mcp/types.ts - Defines the frontend MCP server and request payload shapes.
./src/components/mcp/hooks/useMcpServers.ts - Loads MCP entries, normalizes API results, caches them, and performs server mutations.
./src/components/mcp/view/McpServers.tsx - Renders managed MCP rows as read-only entries in each provider's settings tab.
./src/components/settings/view/SettingsToggle.tsx - Provides the existing accessible switch control used throughout settings.
./src/i18n/locales/en/settings.json - Supplies the canonical English managed-MCP labels and toggle text.
server/modules/providers/list/claude/claude-mcp.provider.ts - Adjacent MCP adapter that must remain unaffected by OpenCode-only enabled state.
server/modules/providers/list/codex/codex-mcp.provider.ts - Adjacent MCP adapter that must remain unaffected by OpenCode-only enabled state.
server/modules/providers/list/cursor/cursor-mcp.provider.ts - Adjacent MCP adapter that must remain unaffected by OpenCode-only enabled state.
src/i18n/locales/de/settings.json - German settings translations should receive the new managed toggle strings.
src/i18n/locales/fr/settings.json - French settings translations should receive the new managed toggle strings.
src/i18n/locales/it/settings.json - Italian settings translations should receive the new managed toggle strings.
src/i18n/locales/ja/settings.json - Japanese settings translations should receive the new managed toggle strings.
src/i18n/locales/ko/settings.json - Korean settings translations should receive the new managed toggle strings.
src/i18n/locales/ru/settings.json - Russian settings translations should receive the new managed toggle strings.
src/i18n/locales/tr/settings.json - Turkish settings translations should receive the new managed toggle strings.
src/i18n/locales/zh-CN/settings.json - Simplified Chinese settings translations should receive the new managed toggle strings.
src/i18n/locales/zh-TW/settings.json - Traditional Chinese settings translations should receive the new managed toggle strings.
./package.json - Defines scoped server tests plus build, typecheck, and lint validation commands.
./AGENTS.md - Requires backend work under `server/` to follow the repository's backend module standards skill.
./.agents/skills/backend-module-standards/SKILL.md - Defines the backend architecture, testing, import, and verification constraints for this change.

# ANALYSIS

The OpenCode MCP format already supports an `enabled` boolean, and CloudCLI currently writes managed Browser MCP entries with `enabled: true`. However, the shared normalized MCP model omits that state, OpenCode list normalization discards it, and the UI treats every `cloudcli-*` entry as wholly read-only. The requested behavior is therefore best implemented by carrying OpenCode's native enabled state through the existing list/upsert API and showing an accessible switch only for the managed `cloudcli-browser` row in the OpenCode settings tab.

Using the existing MCP upsert endpoint avoids adding a feature-specific route: the frontend can submit the existing server definition with only its enabled state changed. The backend parser and shared payload types must accept the optional field, while the OpenCode adapter must serialize and normalize it. Other providers do not have equivalent semantics in the current adapters, so they should ignore the optional field and retain their existing behavior; the switch must not appear in Claude, Codex, or Cursor settings.

Startup reconciliation is the main persistence risk. Browser initialization re-upserts `cloudcli-browser` on every enabled startup, which currently rebuilds the OpenCode entry as enabled and would undo a user's choice. Common upsert behavior therefore needs to make the existing provider-native config available while rebuilding an entry, allowing the OpenCode adapter to preserve an existing `enabled` value whenever the caller does not explicitly provide one. New OpenCode entries should still default to enabled. Tests must cover explicit disabling, list normalization, preservation during ordinary upsert/reconciliation, and Browser startup backfill.

On the frontend, toggling should have a per-server pending state, disable repeated interaction, clear stale errors, invalidate the MCP cache, force a refresh, and surface failures in the existing error area without removing the managed/read-only restrictions on editing and deletion. The UI should label the state clearly and use `SettingsToggle` for keyboard and screen-reader accessibility. Translation keys should be added consistently across all settings locale files so no locale falls back to missing-key output.

# PLAN

1. Extend the normalized MCP contract and OpenCode adapter so `enabled` can be listed and explicitly updated, while omitted enabled state preserves an existing OpenCode value during managed registration reconciliation.
2. Add an OpenCode-only managed Browser MCP switch to the MCP settings row, backed by the existing provider upsert endpoint and existing cache/error patterns.
3. Add localized labels for enabled/disabled state and toggle accessibility text across every settings locale.

# GUIDELINES

- Follow ./AGENTS.md and ./.agents/skills/backend-module-standards/SKILL.md for every backend edit.
- Keep provider routes thin: parse the optional boolean, pass typed data to the service, and leave persistence in the provider adapter.
- Preserve existing MCP behavior for Claude, Codex, and Cursor; only OpenCode serializes and normalizes the native `enabled` property.
- Treat omitted `enabled` differently from explicit `false`: omitted values preserve an existing OpenCode entry's state and default new entries to enabled.
- Only the managed `cloudcli-browser` entry in the OpenCode tab receives the toggle; managed entries remain non-editable and non-deletable.
- Reuse ./src/components/settings/view/SettingsToggle.tsx and existing UI primitives rather than introducing a new switch implementation.
- Keep API calls in ./src/components/mcp/hooks/useMcpServers.ts, invalidate the module cache after mutation, and force-refresh the visible provider.
- Avoid unrelated refactors and keep validation scoped to MCP and Browser feature tests before broader type/build checks.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Extend backend MCP models and OpenCode persistence to expose and update optional enabled state, preserving an existing OpenCode value when managed registration omits it, and add focused regression coverage including Browser startup reconciliation.
  **Files:**
  ./server/shared/types.ts - Add optional enabled state to normalized MCP and upsert payload types with appropriate shared documentation.
  ./server/modules/providers/shared/mcp/mcp.provider.ts - Pass existing provider-native config into entry rebuilding so adapters can preserve provider-specific state.
  ./server/modules/providers/list/opencode/opencode-mcp.provider.ts - Serialize explicit enabled values, preserve existing values when omitted, default new entries to enabled, and normalize enabled state for list responses.
  ./server/modules/providers/provider.routes.ts - Parse an optional boolean enabled field in MCP upsert payloads without changing unrelated routes.
  ./server/modules/providers/tests/mcp.test.ts - Test OpenCode disabled-state persistence, normalized listing, explicit re-enable, and preservation on omitted enabled updates.
  ./server/modules/browser-use/browser-use.service.ts - Read for managed registration behavior; modify only if needed to preserve the OpenCode toggle without changing Browser feature enablement semantics.
  ./server/modules/browser-use/tests/browser-use.service.test.ts - Verify managed Browser MCP startup backfill still defaults new entries on and does not re-enable an existing disabled OpenCode entry.
  server/modules/providers/list/claude/claude-mcp.provider.ts - Contextual adapter that should retain existing config output and behavior.
  server/modules/providers/list/codex/codex-mcp.provider.ts - Contextual adapter that should retain existing config output and behavior.
  server/modules/providers/list/cursor/cursor-mcp.provider.ts - Contextual adapter that should retain existing config output and behavior.
  ./package.json - Provides focused test, build, typecheck, and lint commands.
  **Acceptance criteria:** OpenCode MCP list responses include `enabled`; posting `enabled: false` or `true` persists that exact native state; an omitted value preserves an existing OpenCode state and defaults a new entry to enabled; Browser startup reconciliation does not overwrite a user's disabled state; other providers remain behaviorally unchanged.
  **Validation:** Add/update focused tests in `server/modules/providers/tests/mcp.test.ts` and `server/modules/browser-use/tests/browser-use.service.test.ts`; run `node --import tsx --test server/modules/providers/tests/mcp.test.ts server/modules/browser-use/tests/browser-use.service.test.ts` with the repository TS config environment as needed, then run backend typecheck/build or the closest scoped equivalent permitted by the environment.
  **Summary:** Added optional documented MCP `enabled` fields, passed existing native configs into adapter rebuilding, and taught OpenCode persistence/list normalization to distinguish explicit booleans from omission (preserving existing state and defaulting new entries on). The MCP route validates optional booleans; focused provider and Browser startup tests cover disable, listing, preservation, re-enable, and new-entry backfill. Browser service logic and other provider adapters required no behavior changes. Focused tests and server TypeScript typecheck passed.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Add an accessible per-row enable/disable control for the managed `cloudcli-browser` MCP in OpenCode settings, using the existing MCP upsert endpoint with pending and error handling.
  **Files:**
  ./src/components/mcp/types.ts - Carry optional enabled state through frontend MCP server and upsert payload types.
  ./src/components/mcp/hooks/useMcpServers.ts - Normalize enabled state, perform toggle upserts, track pending/error state, invalidate cache, and refresh after mutation.
  ./src/components/mcp/view/McpServers.tsx - Render the switch and enabled/disabled status only for managed `cloudcli-browser` on the OpenCode tab while retaining managed edit/delete restrictions.
  ./src/components/settings/view/SettingsToggle.tsx - Reuse the repository's accessible settings switch and disabled behavior.
  ./src/i18n/locales/en/settings.json - Read canonical keys added by the localization item and use them for labels, status, and error text.
  ./package.json - Provides client typecheck, build, and lint commands.
  **Acceptance criteria:** The OpenCode MCP settings row for `cloudcli-browser` shows current enabled state and an accessible switch; toggling persists through the backend, disables repeated clicks while saving, refreshes the row, and reports failures; no toggle appears for other managed names or provider tabs; managed edit/delete actions stay hidden.
  **Validation:** Add a focused frontend unit/render test where practical for toggle visibility and payload/state helpers; run that test plus `npm run typecheck`, `npm run build:client`, and scoped ESLint for the touched MCP files when the environment permits.
  **Summary:** Added optional frontend MCP enabled-state transport and normalization, a complete-definition toggle upsert helper, per-server pending/error handling with cache invalidation and forced refresh, and an accessible SettingsToggle rendered only for OpenCode's managed `cloudcli-browser` row. Managed edit/delete restrictions remain unchanged. Added a focused payload helper test; the test, typecheck, client build, and scoped MCP ESLint all passed.

- [x] **ID:** 3 | **Batch:** 1
  **Task:** Add managed MCP enabled/disabled and toggle labels to every settings locale, preserving valid JSON and matching the existing locale structure.
  **Files:**
  ./src/i18n/locales/en/settings.json - Add canonical English managed toggle, state, saving, and failure strings.
  src/i18n/locales/de/settings.json - Add German managed toggle strings.
  src/i18n/locales/fr/settings.json - Add French managed toggle strings.
  src/i18n/locales/it/settings.json - Add Italian managed toggle strings.
  src/i18n/locales/ja/settings.json - Add Japanese managed toggle strings.
  src/i18n/locales/ko/settings.json - Add Korean managed toggle strings.
  src/i18n/locales/ru/settings.json - Add Russian managed toggle strings.
  src/i18n/locales/tr/settings.json - Add Turkish managed toggle strings.
  src/i18n/locales/zh-CN/settings.json - Add Simplified Chinese managed toggle strings.
  src/i18n/locales/zh-TW/settings.json - Add Traditional Chinese managed toggle strings.
  **Acceptance criteria:** Every settings locale contains the same new managed MCP keys, all JSON files parse, and the English wording clearly distinguishes enabled, disabled, saving, enable action, disable action, and save failure.
  **Validation:** Parse all `src/i18n/locales/*/settings.json` files and compare the new key paths across locales; run any existing i18n config test relevant to locale loading.
  **Summary:** Added the same `mcpServers.managed` state/action keys (`enabled`, `disabled`, `saving`, `enable`, `disable`, and `saveFailed`) to all 10 settings locales, adding localized managed badge/hint strings where the locale previously lacked the object. All settings JSON parsed with matching managed key paths, and `src/i18n/config.test.js` passed.

# CHANGELOG

- **Item 3:** Added localized managed MCP enabled/disabled, saving, enable/disable action, and save-failure strings across all settings locales; verified matching key paths, valid JSON, and passing i18n locale-loading tests.
- **Item 1:** Added optional backend MCP enabled-state transport and OpenCode-native persistence/normalization with omitted-value preservation, plus provider and Browser startup regression tests; focused tests and server typecheck passed.
- **Item 2:** Added the OpenCode-only managed `cloudcli-browser` enabled switch with complete-definition upserts, per-row saving/error state, cache invalidation and forced refresh; added a focused payload test and passed typecheck, client build, and scoped ESLint.
