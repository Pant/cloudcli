# CONTEXT

## Files

./server/modules/providers/list/opencode/opencode-sessions.provider.ts - Loads and normalizes OpenCode transcript rows but currently awaits supplemental model-context discovery before returning canonical history.
./server/modules/providers/list/opencode/opencode.provider.ts - Constructs the OpenCode sessions adapter with the models adapter that enables the blocking supplemental context lookup.
./server/modules/providers/list/opencode/opencode-models.provider.ts - Discovers OpenCode model metadata through a CLI subprocess and caches it, with cold discovery measured around three seconds and other live calls observed much longer under concurrent startup load.
./server/modules/providers/services/provider-token-usage.service.ts - Owns the dedicated token-usage endpoint, including supplemental OpenCode context-window enrichment independent of transcript loading.
./server/modules/providers/tests/opencode-sessions.test.ts - Covers OpenCode transcript normalization and currently expects history to await context-window enrichment.
./server/modules/providers/tests/provider-token-usage.service.test.ts - Covers OpenCode context-window enrichment through the dedicated token-usage API path.
./server/modules/providers/tests/sessions-history.routes.test.ts - Covers history response, revision, ETag, conditional requests, and pagination behavior.
./src/components/chat/hooks/useChatSessionState.ts - Opens a session, starts warm-up, and separately fetches token usage without requiring that request to complete before messages render.
./src/stores/useSessionStore.ts - Keeps cached rows visible while the canonical history HTTP request remains in flight and clears canonical loading when that request completes.
./src/components/chat/view/chatDegradedState.utils.ts - Maps visible cached rows plus the local loading flag to the `cached-validating` banner text reported by the user.
./src/components/chat/view/chatDegradedState.test.tsx - Covers banner state classification and degraded-state rendering.
./src/components/chat/hooks/sessionMessageLoading.ts - Ensures cached rows themselves do not block message display during canonical loading.
./src/components/chat/hooks/sessionMessageLoading.test.ts - Covers the non-blocking cached-message display policy.
package.json - Defines backend/provider tests, frontend tests, typechecking, linting, and full build commands used for validation.

# ANALYSIS

The banner duration is not caused by browser message validation. Production logs show the affected `GET /api/providers/sessions/:sessionId/messages` requests taking approximately 8.4–8.5 seconds, while the optimized client validator completes 100–200 messages in far below one millisecond. Direct measurement isolates the backend delay: raw OpenCode history normalization for the reported session takes about 24 ms, but the registered OpenCode sessions provider takes about 2.97 seconds because `fetchHistory` awaits `attachContextWindow`, which calls cold `opencode models --verbose` discovery through `getContextWindowForModel`. Under live startup contention, the same supplemental work coincides with 8+ second history requests, 8+ second token-usage requests, and 16–18 second agent discovery calls.

Canonical transcript delivery should not depend on supplemental context-window metadata. The client already performs an independent `/token-usage` request after session selection, and that endpoint owns context-window enrichment. Therefore the fastest safe fix is to remove blocking model-context discovery from OpenCode history while preserving current token counters/window occupancy already read from SQLite. Canonical history can then return as soon as transcript normalization completes, allowing the store to finish validation and remove the banner. The separate token-usage response can update the context maximum later without delaying messages.

The change must preserve all message normalization, response metadata, token counters, history revision/ETag, conditional 304, pagination, and dedicated token-usage behavior. Tests should explicitly prove history does not await a slow context resolver and that the dedicated token-usage path still enriches the maximum. Live validation should compare the same session before and after the server reload; the target is a warm or cold canonical history response comfortably below one second for ordinary 100–200-message sessions, with the banner no longer persisting due to supplemental model discovery. Existing unrelated working-tree changes must remain untouched, and no VCS operations are requested.

# PLAN

1. Decouple OpenCode canonical history from slow supplemental model-context discovery while preserving transcript and token-counter semantics.
2. Validate backend and frontend integration, reload the server, and benchmark the live canonical history request that previously took more than eight seconds.

# GUIDELINES

- Treat transcript messages, history revision, and strict client contract validation as the canonical-history critical path; supplemental context maximum metadata must not delay it.
- Preserve OpenCode `tokenUsage` counters and `windowTokens` derived directly from SQLite history data; only the separately discoverable model context maximum may arrive later from the dedicated token-usage endpoint.
- Keep `/api/providers/sessions/:sessionId/token-usage` responsible for OpenCode context-window enrichment and preserve its existing failure-tolerant behavior.
- Preserve route response shapes, protocol version, ETag/304 behavior, pagination, message order, response metadata, attachments, tool normalization, and error handling.
- Add a regression proving history resolves before a deliberately slow model-context resolver, rather than relying only on a timing benchmark.
- Follow ./.agents/skills/backend-module-standards/SKILL.md for all backend edits; keep routes thin and changes local to the Providers module.
- Run focused tests before broader typecheck/lint/build checks; do not leave warnings in lint-configured files.
- Do not touch unrelated working-tree changes, use `./tmp`, access `./projects`, or perform VCS operations.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Remove supplemental OpenCode model-context discovery from the canonical history critical path while retaining dedicated token-usage enrichment and all transcript semantics.
  **Files:**
  ./server/modules/providers/list/opencode/opencode-sessions.provider.ts - Return normalized transcript and SQLite-derived token usage without awaiting model catalog/context-window discovery.
  ./server/modules/providers/list/opencode/opencode.provider.ts - Stop coupling the sessions adapter to models if that dependency is no longer needed.
  ./server/modules/providers/tests/opencode-sessions.test.ts - Replace the blocking history-context expectation with regressions that preserve counters and prove a slow supplemental resolver cannot delay history.
  ./server/modules/providers/services/provider-token-usage.service.ts - Preserve the dedicated OpenCode context-window enrichment path; modify only if a narrow adjustment is needed after decoupling.
  ./server/modules/providers/tests/provider-token-usage.service.test.ts - Confirm the dedicated endpoint still attaches known context maximums and fails open when metadata is unavailable.
  ./server/modules/providers/tests/sessions-history.routes.test.ts - Preserve canonical route, ETag/304, and pagination behavior; add timing/decoupling coverage only if service-level coverage is insufficient.
  **Acceptance criteria:** OpenCode history no longer invokes or awaits model-context discovery; transcript messages, ordering, response metadata, token counters, `windowTokens`, pagination, and route contracts remain unchanged; the dedicated token-usage path still enriches `total` when context metadata is available; a deliberately unresolved/slow context resolver cannot hold the history promise open; and no unrelated provider behavior changes.
  **Validation:** Run focused OpenCode sessions, provider token-usage, and history route tests; directly benchmark the registered OpenCode history provider for the affected live session and report duration/message count; run `npm run typecheck:backend`; run scoped ESLint for touched backend files; run `npm run build:server`.
  **Summary:** Removed the models dependency and context-window await from `opencode-sessions.provider.ts`, and registered `OpenCodeSessionsProvider` without models in `opencode.provider.ts`. Replaced history context-enrichment tests with a registered-provider regression proving unresolved model discovery is never invoked while SQLite token counters, `windowTokens`, transcript count, and ordering remain intact. Dedicated token-usage code was unchanged; its enrichment and fail-open tests pass. Validation: 34/34 focused provider/history tests passed; backend typecheck passed; scoped ESLint passed with zero warnings; server build passed. Registered live-session benchmark for `ses_011cc59b8ffe2ley9dimfbXM1q`: 13.45 ms, 56 messages (total 56). The first benchmark command had a shell-quoting syntax error and was immediately rerun successfully.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Reconcile the decoupled backend with client loading/banner behavior, reload CloudCLI, and prove the live canonical history request no longer keeps the cached-validating banner visible for multiple seconds.
  **Files:**
  ./src/components/chat/hooks/useChatSessionState.ts - Confirm canonical history and independent token-usage requests remain decoupled and messages do not wait for token metadata.
  ./src/stores/useSessionStore.ts - Confirm canonical loading ends when the transcript request completes and cache/revision semantics remain intact.
  ./src/components/chat/view/chatDegradedState.utils.ts - Confirm the banner accurately reflects only an in-flight canonical transcript request.
  ./src/components/chat/view/chatDegradedState.test.tsx - Preserve cached/loading/degraded state policy and add a regression only if integration findings require it.
  ./src/components/chat/hooks/sessionMessageLoading.ts - Confirm cached messages remain non-blocking during the shortened canonical request.
  ./src/components/chat/hooks/sessionMessageLoading.test.ts - Preserve non-blocking cached-row policy.
  ./server/modules/providers/list/opencode/opencode-sessions.provider.ts - Validate the final fast backend history path produced by Item 1.
  package.json - Use existing focused test, typecheck, lint, and build commands without broad script changes.
  **Acceptance criteria:** Focused frontend loading/banner tests and backend history tests pass; full typechecking and applicable lint pass without warnings; production builds succeed; after a server reload, the previously slow live session history request completes comfortably below one second in repeated checks and no duplicate canonical request is needed to achieve the fast result; token usage may finish independently without extending canonical loading; and service status is healthy.
  **Validation:** Run focused frontend session-loading/degraded-state tests plus Item 1 backend tests; run `npm run typecheck`; run applicable scoped ESLint; run `npm run build`; use the `cloudcli-reload` skill with `all` because backend output changed and the production frontend/server integration must be current; verify status; issue repeated authenticated/live canonical history requests for the affected session or benchmark the registered provider if authentication blocks direct HTTP, compare against the observed 8.4–8.5 second baseline, and inspect logs for request duration and duplication.
  **Summary:** No integration correction was required. Inspection confirmed cached/displayable messages remain visible while `_canonicalFetchInFlight` alone drives canonical loading/banner state; the transcript promise clears that state independently, while the separate token-usage effect may finish later. Validation passed: 7/7 focused frontend loading/banner tests; 34/34 focused OpenCode/token-usage/history-route tests; full frontend/backend typecheck; scoped ESLint with zero warnings; and full client/server production build including bundle validations. `cloudcli-reload.sh all` rebuilt both outputs and restarted the server child from PID 17898 to 38697; status reported running and the `cloudcli-ui` container remained healthy. Authenticated HTTP credentials were not available from the shell, so the registered provider was benchmarked repeatedly for `ses_011cc59b8ffe2ley9dimfbXM1q`: 9.31, 6.27, 9.10, 7.83, and 7.69 ms for 56/56 messages, comfortably below the 8.4–8.5 second baseline. Post-reload production logs showed ordinary OpenCode histories completing in 8–72 ms while independent token-usage requests could take about 5 seconds; history still completed first, and no duplicate canonical request was needed for the fast result. The initial direct HTTP probes could not connect from the host namespace, and the first backend-test command used unavailable bare `cross-env`; both were replaced with the documented fallback/provider benchmark and `npx cross-env`.

# CHANGELOG

- Item 1: Decoupled OpenCode canonical history from model-context discovery; preserved SQLite usage/transcript semantics and verified focused tests, typecheck, lint, build, and a 13.45 ms/56-message registered-provider benchmark.
- Item 2: Confirmed client canonical/banner and token-usage independence without code changes; passed focused tests, full typecheck/lint/build, all reload/status, and repeated 6.27–9.31 ms registered-provider benchmarks for the 56-message live session, with post-reload logs showing fast history independent of slower token usage.
