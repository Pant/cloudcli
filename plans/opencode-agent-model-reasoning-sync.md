# CONTEXT

## FILES

@/src/components/chat/view/ChatInterface.tsx - Coordinates the selected OpenCode agent with composer model and reasoning controls and is the integration point for persistence feedback.
@/src/components/chat/hooks/useChatProviderState.ts - Owns visible model/reasoning state and currently persists model by provider/session and reasoning only by provider.
@/src/components/chat/hooks/useOpenCodeAgentState.ts - Owns the selected OpenCode agent and a per-agent model cache but has no per-agent reasoning state or config-update operation.
@/src/components/chat/hooks/useChatComposerState.ts - Builds immediate and queued turn options, whose queue-time snapshot currently allows an old model/reasoning choice to survive a later change.
@/src/components/chat/utils/chatStorage.ts - Defines durable queued-message storage and is the narrow utility surface for updating a pending turn to the latest settings.
@/src/components/chat/view/subcomponents/ComposerModelMenu.tsx - Emits model and reasoning selections from the user's chat box.
@/src/i18n/locales/en/chat.json - Contains the English chat strings used for accessible success/failure notifications.
@/server/modules/providers/provider.routes.ts - Exposes provider agent APIs and must parse the focused runtime-settings update request.
@/server/modules/providers/services/agents.service.ts - Provider-neutral service boundary through which the new agent settings update is dispatched.
@/server/modules/providers/list/opencode/opencode-agents.provider.ts - Reads/writes OpenCode agent definitions and already serializes changes through the shared config store.
@/server/modules/providers/list/opencode/opencode-config.provider.ts - Atomically updates the user OpenCode JSON/JSONC configuration without clobbering adjacent settings.
@/server/shared/interfaces.ts - Defines the provider agent contract that the focused update operation must extend.
@/server/shared/types.ts - Holds shared backend agent definition/update result types used by provider, service, and route layers.
@/server/modules/providers/tests/opencode-agents.test.ts - Existing focused tests for OpenCode agent config reads/writes, model qualification, and preservation of unrelated config.
@/.agents/skills/backend-module-standards/SKILL.md - Binding repository rules for every backend file changed by this task.
src/hooks/useQueuedMessageAutoSend.ts - Dispatches queued turns outside the active composer using the options stored at queue time.
server/modules/providers/list/opencode/opencode-runtime.provider.ts - Starts one OpenCode CLI process per turn with explicit model, variant, and agent arguments, so changed selections naturally apply on the next dispatched turn.
package.json - Defines scoped test, typecheck, lint, and build commands.

# ANALYSIS

The requested behavior is specifically meaningful for OpenCode's named-agent composer flow: selecting Architect, Code, or another OpenCode agent must make model and reasoning choices properties of that agent, not shared transient composer preferences. Today model selection is saved by provider/session and mirrored only into a browser-local per-agent model map, while reasoning is saved under one `opencode-effort` key. Consequently switching agents can restore a model but cannot restore a distinct reasoning level, and neither control writes the selected agent's OpenCode configuration.

The backend already has the correct safe write primitive: `OpenCodeConfigStore.updateConfig()` serializes read-modify-write operations and preserves unrelated top-level config. The agent provider also knows how to qualify bare CloudCLI model IDs. A focused runtime-settings operation should update only `config.agent[name].model` and the agent reasoning field, create an override object for built-in agents when necessary, preserve prompt/permissions/description and all unrelated config, and return the normalized persisted values. The current deployed config and existing agent tests represent reasoning as `reasoningEffort`; the runtime sends the chosen level through OpenCode's `--variant` argument. The update should therefore persist `reasoningEffort` as the requested agent-level configuration value while continuing to send it explicitly for the next turn.

Frontend state must be keyed by workspace plus agent so Architect and Code do not leak model or reasoning into each other. On agent switch, both values should restore before the next send. On a user selection, the UI should update optimistically enough to govern the next send, call the focused backend operation, reconcile with the server response, and report success or failure. A small aria-live toast/banner near the chat surface is sufficient; it should distinguish model and reasoning changes and avoid claiming success until persistence succeeds.

An already executing OpenCode turn cannot change process arguments in place. “Next possible turn” therefore means every turn dispatched after the selection, including a message queued while the current run is active. Immediate sends already build options from current React state. Queued sends are the gap: their options are snapshotted at queue time and can be dispatched later by either the composer or `useQueuedMessageAutoSend`. When model/reasoning changes, any queued message for the active session must have those fields patched in both React state and durable storage, without changing its text, attachments, agent, permissions, or tool settings. This makes the queued turn the first possible turn using the new values.

Risks are concurrent model/reasoning updates, failures after optimistic state changes, and built-in agents with no existing user override. Backend writes must remain serialized; frontend mutations should avoid stale responses overwriting a newer choice, and failures should leave a clear notification while retaining or restoring a coherent selection. Scope should remain OpenCode-agent-specific; other providers keep their existing per-provider behavior because they have no named editable agent config.

# PLAN

1. Add a provider-neutral focused agent runtime-settings contract and OpenCode implementation that atomically updates only the named agent's model and/or reasoning value in user config, including built-in agent overrides.
2. Replace browser-only OpenCode agent model memory with workspace-and-agent model/reasoning state hydrated from runtime agent discovery, persist chat-box changes through the new API, and restore both settings when switching agents.
3. Ensure a changed selection patches any active session's pending queued turn so the next dispatch uses the latest model/reasoning, and present accessible success/failure notifications.
4. Run focused backend tests plus repository type/lint/build checks for the integrated result.

# GUIDELINES

- Read this plan before editing. Code agents may edit this plan only for their own item's status marker, Summary field, and one append-only CHANGELOG entry.
- Apply @/.agents/skills/backend-module-standards/SKILL.md to every change under `server/`: routes parse only, services orchestrate, shared multi-consumer contracts stay documented in `server/shared`, and tests remain in the owning provider module.
- Use @/server/modules/providers/list/opencode/opencode-config.provider.ts for serialized atomic config updates; do not write OpenCode config files directly elsewhere.
- The focused config update must preserve every unrelated top-level config key and every unrelated field on the selected agent.
- Keep model values in OpenCode `provider/model-id` form; use the provider's existing bare-model qualification logic rather than duplicating it.
- Persist reasoning using the existing CloudCLI/OpenCode `reasoningEffort` agent option used by the deployed configuration, while runtime turns continue to carry the selected effort explicitly.
- Key frontend OpenCode preferences by workspace plus agent. Do not make Architect and Code share reasoning or model state.
- Only OpenCode named agents receive config mutation; retain existing behavior for Claude, Cursor, and Codex.
- A running process is not mutated. The new choice must govern every subsequently dispatched turn, including an already queued message that has not yet been sent.
- Patch only `model` and `effort` in queued options; preserve queued content, attachments, agent, permissions, and tools.
- Notifications must be visible and announced accessibly, must identify model versus reasoning success, and must not claim success before the backend confirms persistence.
- Avoid unrelated refactors and keep validation scoped until the final integration item.

# TODO

- [ ] **ID:** 1 | **Batch:** 1
  **Task:** Add a focused OpenCode named-agent runtime-settings API that atomically persists model and reasoning changes without replacing the rest of the agent definition or adjacent config.
  **Files:**
  @/server/shared/types.ts - Add documented shared input/result types for a partial named-agent model/reasoning update.
  @/server/shared/interfaces.ts - Extend the configurable-agent provider contract with the focused update operation.
  @/server/modules/providers/services/agents.service.ts - Route provider-neutral runtime-setting updates to the selected provider adapter.
  @/server/modules/providers/provider.routes.ts - Parse and expose the focused OpenCode agent settings endpoint while keeping the route thin.
  @/server/modules/providers/list/opencode/opencode-agents.provider.ts - Implement serialized partial updates, model qualification, reasoning validation, built-in overrides, and preservation of unrelated fields.
  @/server/modules/providers/list/opencode/opencode-config.provider.ts - Reuse the existing synchronized user-config writer; modify only if a narrowly required helper is justified.
  @/server/modules/providers/tests/opencode-agents.test.ts - Cover model-only, reasoning-only, combined, built-in override, validation, and config-preservation behavior.
  @/.agents/skills/backend-module-standards/SKILL.md - Follow all backend architecture and validation requirements.
  **Acceptance criteria:** A request can update either or both `model` and `reasoningEffort` for a named OpenCode agent; bare models are qualified; invalid names/models/reasoning or an empty update are rejected; built-in agents can acquire a user override; unrelated agent fields, sibling agents, MCP, provider, and schema config remain unchanged; the response reports the persisted values.
  **Validation:** Run `node --import tsx --test server/modules/providers/tests/opencode-agents.test.ts` and the narrow server TypeScript check if available.
  **Summary:**

- [ ] **ID:** 2 | **Batch:** 2
  **Task:** Make the OpenCode chat-box model and reasoning controls agent-specific, persist each confirmed selection through the focused API, restore both values on agent switch, and show accessible success/failure notifications.
  **Files:**
  @/src/components/chat/view/ChatInterface.tsx - Integrate selected-agent settings, persistence handlers, stale-request protection, and chat-level notifications.
  @/src/components/chat/hooks/useOpenCodeAgentState.ts - Store model and reasoning by workspace/agent, hydrate agent defaults from discovery, expose update/reconciliation helpers, and stop cross-agent leakage.
  @/src/components/chat/hooks/useChatProviderState.ts - Allow the selected OpenCode agent's restored reasoning/model to drive the composer without changing other providers' behavior.
  @/src/components/chat/view/subcomponents/ComposerModelMenu.tsx - Preserve current menu behavior while invoking async-safe model/reasoning selection handlers.
  @/src/i18n/locales/en/chat.json - Add success and failure strings for model and reasoning config updates.
  @/server/modules/providers/provider.routes.ts - Consume the endpoint contract completed by item 1; do not alter backend behavior outside integration needs.
  **Acceptance criteria:** Architect, Code, and every other OpenCode agent retain independent model and reasoning values per workspace; switching agents immediately restores both controls; selecting either value updates the named agent's OpenCode config and all future composer sends; success is visibly and accessibly confirmed separately for model and reasoning; a failed update displays an error and does not allow an older response to overwrite a newer selection; non-OpenCode providers remain unchanged.
  **Validation:** Add focused frontend unit tests for extracted state/storage helpers where practical, then run those tests and `npm run typecheck` scoped by the available tooling.
  **Summary:**

- [ ] **ID:** 3 | **Batch:** 2
  **Task:** Update active-session queued turn snapshots whenever the user changes model or reasoning so the first turn after an ongoing run uses the latest selected values.
  **Files:**
  @/src/components/chat/hooks/useChatComposerState.ts - Expose or consume a narrow mechanism that patches queued React state when active model/reasoning changes.
  @/src/components/chat/utils/chatStorage.ts - Add a tested utility that patches only model/effort in a durable queued message's options.
  @/src/hooks/useQueuedMessageAutoSend.ts - Confirm background auto-send consumes the patched durable options; adjust only if needed.
  **Acceptance criteria:** If a run is active and a message is queued, changing model or reasoning before dispatch updates that pending message to the new value; both composer-owned and background auto-send paths use the patched settings; all other queued fields remain unchanged; queues for unrelated sessions are untouched.
  **Validation:** Add and run focused tests for queued-message option patching and run the affected TypeScript check.
  **Summary:**

- [ ] **ID:** 4 | **Batch:** 3
  **Task:** Reconcile the completed backend/frontend work, fix integration-only issues, and execute the final scoped validation suite.
  **Files:**
  @/server/modules/providers/tests/opencode-agents.test.ts - Re-run focused config persistence coverage after integration.
  @/src/components/chat/view/ChatInterface.tsx - Check final handler contracts and notification rendering.
  @/src/components/chat/hooks/useOpenCodeAgentState.ts - Check per-agent restoration and API response reconciliation.
  @/src/components/chat/hooks/useChatComposerState.ts - Check immediate and queued next-turn option behavior.
  @/src/components/chat/utils/chatStorage.ts - Check durable queued option patching.
  @/package.json - Use repository-supported test, typecheck, lint, and build commands.
  **Acceptance criteria:** All item outputs compile together; focused tests pass; no unrelated behavior or files are changed; any pre-existing validation failures are clearly distinguished from task regressions.
  **Validation:** Run the focused backend and frontend tests, `npm run typecheck`, targeted ESLint on touched files where supported, and `npm run build` if the environment permits.
  **Summary:**

# CHANGELOG
