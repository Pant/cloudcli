CONTEXT

The token displays share one viewed-session snapshot: the composer badge renders `tokenBudget`, `/cost` sends that same snapshot through the command context, and OpenCode per-message footers render `responseMetadata` attached to normalized assistant rows. OpenCode 1.18.15 emits a `step_finish` JSON event before process close whose `part.tokens` contains input, output, reasoning, cache-read, and cache-write counters, but CloudCLI currently normalizes that event only as `stream_end`, reads aggregate usage from SQLite after the process closes, and then performs delayed canonical-history retries before message metadata appears. The working tree already contains extensive unrelated and overlapping uncommitted changes, including response-metadata and completion-refresh work, so implementations must preserve and integrate with the current files rather than restoring their base versions. Backend changes must follow `.agents/skills/backend-module-standards/SKILL.md`; validation uses Node tests, TypeScript checks, ESLint with zero warnings, and the repository build scripts. After source changes, the running service should be reloaded with the `cloudcli-reload` skill if validation succeeds.

FILES

.agents/skills/backend-module-standards/SKILL.md - Defines mandatory architecture and validation rules for touched backend modules.
./server/modules/providers/list/opencode/opencode-runtime.provider.ts - Runs `opencode --format json`, forwards live events, and currently publishes token usage only during process close.
./server/modules/providers/list/opencode/opencode-sessions.provider.ts - Normalizes OpenCode live and persisted messages and currently turns `step_finish` into metadata-free `stream_end` events.
./server/modules/providers/list/opencode/opencode-token-usage.provider.ts - Holds the shared OpenCode current-window extractor used by runtime, history, and REST usage paths.
./server/modules/providers/tests/opencode-runtime.test.ts - Covers OpenCode runtime event ordering and live token-budget payloads.
./server/modules/providers/tests/opencode-sessions.test.ts - Covers OpenCode live normalization, historical response metadata, and aggregate token usage.
./server/modules/providers/tests/opencode-token-usage.test.ts - Covers trustworthy OpenCode token extraction and schema edge cases.
./shared/cloudcli-contracts.ts - Defines normalized-message `responseMetadata` and token-bearing realtime message contracts already present in the working tree.
./src/stores/useSessionStore.ts - Finalizes streamed assistant rows and owns canonical/realtime message reconciliation and session token snapshots.
./src/stores/sessionStore.helpers.ts - Provides pure realtime stream and response-metadata reconciliation helpers suitable for focused tests.
./src/stores/sessionStore.helpers.test.ts - Covers realtime stream finalization and canonical response-metadata readiness.
./src/components/chat/hooks/useChatRealtimeHandlers.ts - Applies live `token_budget` status events and launches completion fallback refreshes.
./src/components/chat/utils/tokenUsageRefresh.ts - Currently waits for OpenCode canonical metadata retry delays before fetching the fallback aggregate usage snapshot.
./src/components/chat/utils/tokenUsageRefresh.test.ts - Verifies completion refresh ordering, stale-result fencing, retries, and aggregate snapshot application.
./src/components/chat/view/subcomponents/MessageComponent.tsx - Renders OpenCode per-response input/output token metadata in chat messages.
./src/components/chat/view/subcomponents/TokenUsageSummary.tsx - Renders the current-context token snapshot in the composer.
./src/components/chat/hooks/useChatComposerState.ts - Sends the viewed token snapshot to `/cost`, making popup freshness depend on immediate snapshot updates.
package.json - Defines the focused tests, typechecks, lint, and build commands used for validation.

ANALYSIS

The delay has two independent causes. First, the backend ignores the token-rich `step_finish` payload and waits until child-process close to query provider storage; new OpenCode sessions therefore cannot update the composer or `/cost` at the point usage is reported. Second, per-message metadata is hydrated from persisted history after completion, and the current frontend completion controller intentionally retries at 150, 350, 700, and 1200 milliseconds before it performs the aggregate token request. The authoritative OpenCode v1.18.15 run implementation confirms that JSON mode emits `step_finish` with the whole part, and the generated SDK schema confirms that this part contains exact per-step token components.

The fast path should be event-driven. Each trustworthy `step_finish` must immediately produce a `stream_end` carrying exact per-response metadata so the frontend can finalize the visible streamed assistant row with its token footer in the same websocket event turn. The runtime must also derive and publish a comprehensive `token_budget` snapshot from the same event, accumulating per-step components for the run and seeding resumed sessions from provider storage where available; this snapshot is already consumed by both the composer and `/cost`. Provider-storage reads remain an eventual-authority fallback, not a prerequisite for first paint.

The frontend must retain metadata from `stream_end` when converting the live stream placeholder into the final assistant row. Completion recovery should start its aggregate token fetch immediately rather than placing it behind canonical-history retry delays; history retries may continue for durable reconciliation and richer persisted metadata, but they must not gate any token display. Existing ticket and view-generation fences must remain intact so fast requests cannot write into a switched session. Invalid, missing, zero-only, or older-schema data must preserve current stabilization semantics and never replace trustworthy usage with placeholder zeroes.

The main risks are double-counting a step already reflected in a SQLite baseline, attaching metadata to a tool-only step or the wrong assistant row, and overwriting a newer live snapshot with a stale fallback response. Runtime accumulation should use a baseline captured before the run and add each accepted `step_finish` exactly once, while response metadata should be carried only on the terminal event that finalizes the current response stream. Focused tests need to assert event ordering: token metadata and the token-budget status are emitted before `complete`, the frontend final row receives metadata immediately, and fallback token fetching is initiated without waiting for history retry delays.

PLAN

Use OpenCode's token-bearing `step_finish` event as the primary realtime source instead of waiting for process close or provider-storage reconciliation. First, normalize exact per-response metadata and emit an accumulated live token-budget status before completion. Then make the session store preserve terminal metadata on the visible response and restructure completion recovery so the aggregate token endpoint starts immediately while canonical history reconciliation continues independently. Preserve provider-storage and history fetches as fenced fallbacks, add focused regression coverage at each boundary, run the repository checks without warnings, and reload the running CloudCLI source outputs.

GUIDELINES

- Preserve all unrelated and overlapping working-tree changes; do not reset, replace, or broadly reformat current files.
- Follow .agents/skills/backend-module-standards/SKILL.md for every backend edit, including module-local placement, comments, imports, and tests.
- Treat the OpenCode v1.18.15 `step_finish.part.tokens` schema as authoritative: input, output, reasoning, cache.read, and cache.write are non-negative per-step components.
- Keep `responseMetadata.inputTokens` and `outputTokens` exact to one model response; aggregate/session counters belong only in `tokenBudget` snapshots.
- Emit valid live snapshots before `complete` and retain REST/history reads as eventual-authority fallbacks rather than synchronous prerequisites.
- Keep session id, ticket, generation, and active-view fences intact; no token result may cross sessions or overwrite a newer live result.
- Do not turn missing or malformed values into trustworthy zeroes, and preserve the existing placeholder-zero stabilization behavior.
- Add focused tests for every changed behavior and run validation specified by each item with zero warnings.
- Do not perform any Git operation.

TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Implement the OpenCode realtime token fast path by extracting trustworthy per-step usage from `step_finish`, attaching exact response metadata to the normalized terminal event, and emitting an accumulated token-budget snapshot before completion without waiting for process-close storage reads.
  **Files:**
  ./server/modules/providers/list/opencode/opencode-runtime.provider.ts - Accumulate live step usage, seed resumed-session totals safely, publish immediate token-budget status events, and retain close-time storage fallback behavior.
  ./server/modules/providers/list/opencode/opencode-sessions.provider.ts - Normalize token-bearing `step_finish` payloads into terminal events with exact response metadata.
  ./server/modules/providers/list/opencode/opencode-token-usage.provider.ts - Reuse or extend provider-local trustworthy token parsing without duplicating shared extraction logic.
  ./server/modules/providers/tests/opencode-runtime.test.ts - Assert live token-budget payloads are emitted from step completion before terminal completion and are accumulated exactly once.
  ./server/modules/providers/tests/opencode-sessions.test.ts - Assert live `step_finish` normalization carries valid per-response metadata and rejects malformed usage safely.
  ./server/modules/providers/tests/opencode-token-usage.test.ts - Cover any shared token parser or baseline behavior introduced for the realtime path.
  **Acceptance criteria:** A valid OpenCode `step_finish` immediately yields exact per-response metadata and a comprehensive viewed-session token snapshot before `complete`; multiple steps accumulate without double counting; resumed sessions preserve existing totals; malformed or unavailable usage falls back to existing storage behavior; unrelated provider behavior is unchanged.
  **Validation:** Run the focused OpenCode provider runtime, sessions, and token-usage tests, then `npm run typecheck:backend`; run ESLint on every touched backend file with zero warnings.
  **Summary:** Added shared strict step-token extraction, exact live response metadata, and runtime per-step accumulation with provider-storage baselines, duplicate-step fencing, immediate pre-complete token-budget events, and unchanged close-time fallback when live usage is unavailable. Updated the three focused provider test files. Validation passed: 44 focused tests, backend typecheck, and ESLint with zero warnings. The required backend standards skill file was not present in this working tree, so repository conventions and the plan's binding guidelines were followed directly.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Make frontend token displays consume the realtime fast path immediately by preserving terminal response metadata on finalized chat rows and starting completion fallback token fetching without waiting for canonical-history retries, then validate and reload the complete change.
  **Files:**
  ./src/stores/useSessionStore.ts - Preserve response metadata from terminal realtime events when finalizing the visible assistant stream and keep newer live token state protected from stale reconciliation.
  ./src/stores/sessionStore.helpers.ts - Add focused pure reconciliation logic if needed for metadata-aware stream finalization.
  ./src/stores/sessionStore.helpers.test.ts - Assert finalized realtime assistant rows receive terminal response metadata immediately and keep correct replacement semantics.
  ./src/components/chat/hooks/useChatRealtimeHandlers.ts - Continue applying live token-budget events immediately and coordinate non-blocking completion fallbacks.
  ./src/components/chat/utils/tokenUsageRefresh.ts - Start aggregate token fetching immediately and decouple it from delayed canonical metadata retries while retaining cancellation fences.
  ./src/components/chat/utils/tokenUsageRefresh.test.ts - Assert token fallback starts before any retry delay, canonical retries continue independently, and stale results remain fenced.
  ./src/components/chat/view/subcomponents/MessageComponent.tsx - Verify the existing response footer renders newly attached live metadata without adding display delay.
  ./src/components/chat/view/subcomponents/TokenUsageSummary.tsx - Verify the composer badge continues to render the shared live snapshot immediately.
  ./src/components/chat/hooks/useChatComposerState.ts - Verify `/cost` continues to use the same freshly updated snapshot without an additional fetch or delay.
  **Acceptance criteria:** The current-context composer count and `/cost` data update in the same realtime event flow as OpenCode step completion; the visible assistant message receives its per-response input/output count without waiting for history polling; completion fallback requests begin immediately, cannot cross session/view generations, and cannot replace newer trustworthy live values; all existing token stabilization and non-OpenCode behavior remains intact; the running CloudCLI service is reloaded with the appropriate source rebuild.
  **Validation:** Run focused frontend session-store, token-refresh, token-summary, command-modal, and message-layout tests; run `npm run typecheck`, `npm run lint`, and `npm run build`; load and use the `cloudcli-reload` skill for the appropriate full reload and confirm status, with zero warnings.
  **Summary:** Preserved terminal realtime response metadata when finalizing visible assistant stream rows via a focused pure helper. Decoupled aggregate token fallback fetching from canonical-history retries so both begin immediately and continue independently, while retaining session/ticket/view fences and adding a live-snapshot version fence so stale REST snapshots cannot replace newer trustworthy websocket values. Updated focused session-store and token-refresh tests; existing token summary, command modal, and message layout paths required no UI changes. Validation passed: 47 focused frontend tests, full typecheck, lint with zero warnings, and production build. Loaded the reload skill, performed a full reload, and confirmed the service running with child PID 51734.

CHANGELOG

- TODO 1: Implemented and validated the OpenCode realtime step-finish token fast path, including exact terminal response metadata, baseline-aware accumulated snapshots, duplicate suppression, and storage fallback preservation.
- TODO 2: Finalized live assistant rows with terminal response metadata, launched aggregate usage fallback concurrently with canonical retries under session/view/live-version fences, passed all frontend and repository validation, and completed a healthy full service reload.
