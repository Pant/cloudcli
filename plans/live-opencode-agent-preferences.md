# CONTEXT

CloudCLI is a React 18/Vite frontend with a TypeScript/Express backend. The chat composer already exposes OpenCode agent, model, and reasoning controls, sends all three on each turn, stores session models, and discovers configured OpenCode agents. However, composer model changes currently update only the browser/session model, reasoning is one browser preference shared by the whole OpenCode provider, and neither control patches the selected agent's OpenCode config. Queued next turns snapshot their settings, so a later selection does not currently affect an already queued turn.

The backend already owns an atomic serialized OpenCode JSON/JSONC config store and global agent CRUD adapter. Runtime agent inspection exposes resolved model data and returns `reasoningEffort` under the agent's resolved options. The repository requires backend changes to follow `./.agents/skills/backend-module-standards/SKILL.md`; provider routes must remain thin and tests belong in the owning module. The relevant commands are narrow Node tests through `node --import tsx --test`, plus `npm run typecheck`, `npm run lint`, and `npm run build` when appropriate.

## FILES

./AGENTS.md - Repository guidance requiring the backend module standards skill for changes under `./server/`. (required)
./.agents/skills/backend-module-standards/SKILL.md - Binding backend architecture, export, route, and validation rules. (required)
./server/shared/types.ts - Shared provider agent inventory and configuration types that must carry resolved reasoning and preference-patch data. (required)
./server/shared/interfaces.ts - Provider agent adapter contract used by the provider service. (required)
./server/modules/providers/list/opencode/opencode-config.provider.ts - Atomic serialized OpenCode config reader/writer used for safe in-place updates. (required)
./server/modules/providers/list/opencode/opencode-agents.provider.ts - OpenCode runtime inventory parsing and global agent config mutation implementation. (required)
./server/modules/providers/services/agents.service.ts - Thin provider-neutral service facade for agent operations. (required)
./server/modules/providers/provider.routes.ts - Provider HTTP routes where a narrow selected-agent preferences endpoint belongs. (required)
./server/modules/providers/tests/opencode-agents.test.ts - Existing OpenCode agent/config tests to extend for partial model and reasoning updates. (required)
./src/types/app.ts - Frontend runtime agent option type consumed by composer state. (required)
./src/components/chat/hooks/useOpenCodeAgentState.ts - Workspace-aware selected-agent state, stored model preferences, and runtime catalog loading. (required)
./src/components/chat/hooks/useChatProviderState.ts - Current provider model and reasoning state plus active-session model persistence. (required)
./src/components/chat/hooks/useChatComposerState.ts - Per-turn option construction and queued-draft ownership where live setting changes must update the next queued turn. (required)
./src/components/chat/utils/chatStorage.ts - Durable queued-message storage shared by the composer and background auto-send path. (required)
./src/hooks/useQueuedMessageAutoSend.ts - Background dispatcher that sends persisted queued options after a running turn finishes. (required)
./src/components/chat/view/ChatInterface.tsx - Integration point coordinating agent switches, model/reasoning selections, persistence, queue updates, and success feedback. (required)
./src/components/chat/view/subcomponents/ChatComposer.tsx - Composer shell where non-blocking setting-change feedback can be rendered. (required)
./src/components/chat/view/subcomponents/ComposerModelMenu.tsx - Existing model/reasoning picker whose callbacks initiate preference changes. (required)
./src/components/chat/view/subcomponents/ComposerAgentMenu.tsx - Existing OpenCode agent picker used to verify per-agent restoration. (required)
./src/i18n/locales/en/chat.json - English chat strings for model/reasoning success notifications. (required)
./src/components/chat/utils/providerModelCatalog.test.ts - Example of the frontend's narrow Node/tsx test style.

# ANALYSIS

The requested behavior is specific to OpenCode named agents, especially Architect and Code. A model or reasoning choice made while one of those agents is selected must become that agent's durable global default in OpenCode's config, while remaining isolated from every other agent. Switching agents must restore each agent's own configured model and reasoning rather than retaining the previously selected agent's reasoning. The existing global-agent CRUD endpoint is too broad for frequent composer changes because the frontend does not own every config field and must not overwrite prompts, permissions, tools, or arbitrary provider options; a partial preferences operation in the existing agent adapter is the safe contract.

The partial backend update should accept model and/or reasoning effort, require an existing global configurable agent, qualify bare model IDs through the existing model normalization, preserve every unrelated agent/config field, and treat the UI's Default reasoning selection as removal of `reasoningEffort` rather than a literal unsupported level. Runtime inventory should expose the resolved reasoning effort alongside the model so the browser can initialize and restore values from the real agent config. Native or project-only agents that do not exist in the user-global config cannot be durably patched by this endpoint; the composer should surface persistence failure rather than silently claim success.

Frontend state must become per-agent for both model and reasoning. Runtime-config values are authoritative when catalogs load, with local storage serving as a responsive cache. Agent switching should restore the selected agent's pair without generating a false success notification. User-initiated model and reasoning changes should patch the selected agent config, update the active session model where applicable, update local state/cache, and display an accessible transient confirmation only after successful persistence. Existing provider behavior outside OpenCode should remain unchanged.

An in-flight provider call cannot be changed mid-response, so “next possible turn” means all subsequent sends, including a turn already queued behind the active response. Immediate future sends already read current React state; queued messages are the gap because they snapshot options. The queue storage/state therefore needs a scoped option-patch mechanism: model/reasoning updates apply to queued messages using that same agent, while an agent switch updates the current session's queued turn to the newly selected agent and its restored model/reasoning. The in-memory queued draft and its persisted record must stay synchronized so the existing composer flush and background auto-send both dispatch the new settings.

Main risks are accidental full-agent overwrites, feedback emitted before all required persistence succeeds, stale async responses when users switch values quickly, and queue state writing old snapshots back over patched storage. Tests should cover config preservation/default removal, runtime reasoning extraction, per-agent preference normalization/restoration helpers, and queued option patch semantics. No user clarification is necessary because the repository and current Architect/Code config establish the intended scope and OpenCode uses `reasoningEffort` as the configured option.

# PLAN

1. Add a provider-agent partial preferences contract and implement an OpenCode config patch operation that safely updates only model and reasoning while exposing resolved reasoning in runtime inventory.
2. Refactor frontend OpenCode agent preference state so model and reasoning are cached/restored per workspace and agent, and add a focused API call for durable selected-agent updates.
3. Make queued next-turn options patchable so changes made during a running response are used when that queued turn is eventually sent.
4. Integrate user-initiated model/reasoning changes in the chat view, await required persistence, restore settings on agent switches, and show accessible success feedback.

# GUIDELINES

- Use root-relative `./` paths throughout this plan and in delegated task prompts; do not use `@/` aliases or mention paths.
- Apply `./.agents/skills/backend-module-standards/SKILL.md` to every backend edit: keep `./server/modules/providers/provider.routes.ts` transport-only, put behavior in provider services/adapters, use shared definitions only when consumed across files, and keep tests in `./server/modules/providers/tests/`.
- The backend preference update is partial and must preserve prompts, descriptions, modes, permissions, tools, sampling values, hidden/disabled state, and arbitrary options not explicitly changed.
- Persist model and reasoning only for the selected OpenCode named agent; do not change behavior for Claude, Cursor, or Codex.
- Treat reasoning `default` as clearing the agent's `reasoningEffort` config entry; concrete values remain provider option strings after trim/validation.
- Do not show a success notification until the required OpenCode agent config update succeeds; log or surface failures without falsely confirming them.
- Automatic restoration during agent/session/catalog synchronization must not produce success notifications.
- Preserve the existing active-session model persistence as well as the new agent-default persistence.
- A queued next turn is mutable configuration, not an immutable historical send: update its model, reasoning, and agent at the next safe turn boundary according to the latest user selections.
- Avoid unrelated refactors, notification-system redesign, database schema changes, and VCS operations.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Implement a partial provider-agent preference update contract and OpenCode adapter/service/route support that updates only an existing agent's model and reasoning effort in the global config, preserves unrelated config, clears reasoning on `default`, and includes resolved reasoning in available-agent inventory.
  **Files:**
  ./AGENTS.md - Repository guidance for backend work. (required)
  ./.agents/skills/backend-module-standards/SKILL.md - Backend architecture rules that must be followed. (required)
  ./server/shared/types.ts - Add shared runtime reasoning and preference-patch/result types. (required)
  ./server/shared/interfaces.ts - Extend the provider agent contract with the partial update operation. (required)
  ./server/modules/providers/list/opencode/opencode-config.provider.ts - Existing atomic config store used by the adapter. (required)
  ./server/modules/providers/list/opencode/opencode-agents.provider.ts - Parse resolved reasoning and implement safe partial config mutation. (required)
  ./server/modules/providers/services/agents.service.ts - Expose the adapter operation through the provider service. (required)
  ./server/modules/providers/provider.routes.ts - Add and validate a thin selected-agent preferences route. (required)
  ./server/modules/providers/tests/opencode-agents.test.ts - Add tests for runtime reasoning extraction, partial preservation, model qualification, default clearing, and missing-agent rejection. (required)
  **Acceptance criteria:** The available-agent API returns each runtime agent's configured reasoning effort when present; a partial preference request can update model only, reasoning only, or both for an existing OpenCode global agent; `default` removes `reasoningEffort`; all unrelated config fields and top-level config are preserved; invalid payloads and missing/non-configurable agents fail clearly; non-OpenCode unsupported providers still use the provider capability error path.
  **Validation:** Run `node --import tsx --test server/modules/providers/tests/opencode-agents.test.ts`, then `npm run typecheck` for the backend/shared contract changes.
  **Summary:** Added shared runtime reasoning and partial preference contracts in `./server/shared/types.ts` and `./server/shared/interfaces.ts`; implemented atomic existing-global-agent model/reasoning patches in `./server/modules/providers/list/opencode/opencode-agents.provider.ts`, exposed them through `./server/modules/providers/services/agents.service.ts` and a validated thin route in `./server/modules/providers/provider.routes.ts`, and extended `./server/modules/providers/tests/opencode-agents.test.ts` for runtime extraction, partial preservation, model qualification, default clearing, and missing-agent rejection. The config store already provided the required serialized atomic update primitive, so `./server/modules/providers/list/opencode/opencode-config.provider.ts` required no change.

- [x] **ID:** 2 | **Batch:** 1
  **Task:** Add pure queued-message option patching utilities and wire the composer so current-session queued drafts can be updated in memory and durable storage when agent/model/reasoning selections change during an active run, without altering unrelated send options or attachments.
  **Files:**
  ./src/components/chat/utils/chatStorage.ts - Add typed, session-scoped queued option patch/read-write behavior. (required)
  ./src/components/chat/hooks/useChatComposerState.ts - Expose a callback that patches both the owned in-memory queued draft and durable record. (required)
  ./src/hooks/useQueuedMessageAutoSend.ts - Confirm the background sender consumes patched durable options without changing its ownership semantics. (required)
  ./src/components/chat/utils/chatStorage.test.ts - Add focused tests for preserving unrelated options/attachments and patching model, effort, and agent.
  **Acceptance criteria:** A queued message can be patched by session ID with latest model/effort/agent values; attachments, content, permission mode, tool settings, and notification summary remain intact; the mounted composer's in-memory queued draft cannot later overwrite the patched durable options; both composer flush and background auto-send continue using the stored/patched option object; missing queued messages are a no-op.
  **Validation:** Implement and run `node --import tsx --test src/components/chat/utils/chatStorage.test.ts`, then run `npm run typecheck` for the changed frontend types/hooks.
  **Summary:** Added typed model/effort/agent queued-option patches in `./src/components/chat/utils/chatStorage.ts`, exposed `patchQueuedDraftOptions` from `./src/components/chat/hooks/useChatComposerState.ts` to synchronize durable and composer-owned in-memory drafts, and added preservation/no-op tests in `./src/components/chat/utils/chatStorage.test.ts`. Confirmed `./src/hooks/useQueuedMessageAutoSend.ts` already reads and sends the durable stored options without requiring an ownership change.

- [x] **ID:** 3 | **Batch:** 2
  **Task:** Refactor OpenCode composer agent state to maintain model and reasoning preferences per workspace/agent, hydrate them from runtime inventory, expose async durable preference updates through the new backend API, and restore each agent's independent values when switching agents.
  **Files:**
  ./src/types/app.ts - Carry optional reasoning effort on runtime agent options. (required)
  ./src/components/chat/hooks/useOpenCodeAgentState.ts - Own per-agent preference cache, normalization, API updates, and restoration helpers. (required)
  ./src/components/chat/constants/providerEffort.ts - Reuse the canonical default reasoning sentinel. (required)
  ./server/shared/types.ts - Consume the runtime/persistence response shape implemented by item 1. (required)
  ./server/modules/providers/provider.routes.ts - Consume the preferences endpoint implemented by item 1. (required)
  ./src/components/chat/hooks/useOpenCodeAgentState.test.ts - Add focused tests for per-agent isolation, runtime hydration, default clearing normalization, and preference restoration helpers.
  **Acceptance criteria:** Architect and Code (and any other configurable OpenCode agents) retain separate model and reasoning values; switching agents resolves the selected agent's configured/cached pair rather than carrying over the previous agent's reasoning; updates call the partial backend endpoint and update cache only with normalized successful results; runtime catalog data seeds both values; `default` remains the frontend selection when reasoning is absent.
  **Validation:** Implement and run `node --import tsx --test src/components/chat/hooks/useOpenCodeAgentState.test.ts`, then run `npm run typecheck`.
  **Summary:** Added optional runtime reasoning to `./src/types/app.ts`; refactored `./src/components/chat/hooks/useOpenCodeAgentState.ts` with workspace/agent-keyed model and reasoning cache, runtime-authoritative hydration, `default` normalization, restoration helpers, and a normalized-success-only PATCH client for the item 1 endpoint; and added focused coverage in `./src/components/chat/hooks/useOpenCodeAgentState.test.ts`. Existing model cache APIs remain available for item 4 integration compatibility.

- [x] **ID:** 4 | **Batch:** 3
  **Task:** Integrate durable per-agent model/reasoning changes into the chat interface, update active-session and queued next-turn settings, restore settings on agent switches without notifications, and render accessible transient success feedback for user-initiated model and reasoning updates.
  **Files:**
  ./src/components/chat/view/ChatInterface.tsx - Coordinate agent switching, persistence ordering, queue patching, stale-operation safety, and notification state. (required)
  ./src/components/chat/hooks/useOpenCodeAgentState.ts - Use the per-agent preference API and restoration output from item 3. (required)
  ./src/components/chat/hooks/useChatProviderState.ts - Apply restored/current reasoning and retain active-session model persistence. (required)
  ./src/components/chat/hooks/useChatComposerState.ts - Use the queued option patch callback from item 2. (required)
  ./src/components/chat/view/subcomponents/ChatComposer.tsx - Render the accessible transient success notification near the composer. (required)
  ./src/components/chat/view/subcomponents/ComposerModelMenu.tsx - Preserve selection callbacks and menu behavior while async integration occurs above it. (required)
  ./src/components/chat/view/subcomponents/ComposerAgentMenu.tsx - Preserve agent-switch UX while the integration restores per-agent values. (required)
  ./src/i18n/locales/en/chat.json - Add clear success messages for model and reasoning changes. (required)
  ./src/components/chat/view/ChatInterface.agentPreferences.test.ts - Add focused integration/helper tests for agent-switch restoration, queued next-turn updates, and success-only notification behavior.
  **Acceptance criteria:** Selecting an OpenCode model updates the selected agent's config in place, retains active-session persistence, updates a queued next turn, and shows a model success notification only after success; selecting reasoning does the equivalent and remains isolated per agent; switching between Architect and Code restores each agent's independent model/reasoning and updates a current queued next turn without showing a false success; changes made while a response is running are sent on the next queued or newly submitted turn; non-OpenCode provider behavior is unchanged; feedback is accessible via an `aria-live`/status region and auto-dismisses.
  **Validation:** Implement and run `node --import tsx --test src/components/chat/view/ChatInterface.agentPreferences.test.ts`, then run `npm run typecheck`, `npm run lint -- --quiet`, and `npm run build` if the scoped checks pass.
  **Summary:** Integrated durable OpenCode agent model/reasoning updates, active-session model persistence, stale-operation guards, and queued next-turn patching in `./src/components/chat/view/ChatInterface.tsx`, with the sequencing helper in `./src/components/chat/view/agentPreferenceIntegration.ts`; added accessible auto-dismissing success feedback in `./src/components/chat/view/subcomponents/ChatComposer.tsx` and English messages in `./src/i18n/locales/en/chat.json`; and added focused success/failure/stale ordering coverage in `./src/components/chat/view/ChatInterface.agentPreferences.test.ts`. Existing menu components and completed hooks required no changes because their callbacks and APIs already supported the integration.

# CHANGELOG

- **Item 2:** Added session-scoped queued option patching for model, effort, and agent, synchronized composer memory with durable storage, and added focused preservation/no-op tests.
- **Item 1:** Added resolved runtime reasoning inventory and a validated provider-agent preferences patch contract, with atomic OpenCode model/reasoning updates that preserve unrelated config and clear reasoning on `default`, plus focused adapter tests.
- **Item 3:** Added workspace/agent-isolated model and reasoning preferences, runtime hydration and default normalization, durable normalized PATCH updates, restoration helpers, and focused tests.
- **Item 4:** Integrated success-gated per-agent model/reasoning persistence with active-session and queued-turn updates, stale-operation safety, agent-switch restoration without false feedback, accessible auto-dismiss notifications, and focused integration-helper tests.
