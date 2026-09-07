# Fix CloudCLI Runtime Performance Hot Loops

## CONTEXT

### Files

./server/modules/providers/list/opencode/opencode-activity-inspector.provider.ts - Reads native OpenCode task/subagent activity from the shared SQLite database for running and lifecycle status.
./server/modules/providers/services/sessions.service.ts - Builds the `/sessions/running` and `/sessions/status` snapshots that currently invoke the OpenCode activity inspector independently.
./server/modules/providers/services/provider-runtime.service.ts - Exposes OpenCode child activity to WebSocket recovery and must continue receiving correct provider-neutral snapshots.
./server/modules/providers/tests/opencode-activity-inspector.test.ts - Focused coverage for task lifecycle parsing, active-child resolution, and malformed database handling.
./server/modules/providers/tests/sessions.service.test.ts - Focused coverage for canonical running and lifecycle session snapshots.
./src/components/app/AppContent.tsx - Owns foreground running/lifecycle synchronization and currently requests two expensive endpoints in parallel.
./src/components/app/sessionActivitySync.ts - Controls event invalidation and active/idle fallback polling cadence for running/lifecycle state.
./src/components/app/sessionActivitySync.test.ts - Focused tests for coalescing, visibility gating, and polling cadence.
./src/hooks/useProjectsState.ts - Handles watcher `session_upserted` events and signals the viewed transcript to refresh.
./src/hooks/projectStateUtils.ts - Contains the revision-based guard that should suppress duplicate external transcript refreshes.
./src/hooks/projectStateUtils.test.ts - Focused tests for external transcript refresh signaling.
./src/stores/useSessionStore.ts - Owns canonical transcript fetch/refresh deduplication and stable session-store callbacks.
./src/components/chat/hooks/useChatSessionState.ts - React effect consumer whose dependencies currently allow repeated transcript refreshes when store identity changes.
./src/components/chat/hooks/sessionMessageLoading.test.ts - Existing focused chat loading coverage and a suitable neighboring validation surface.
./src/contexts/webSocketTransport.ts - Resolves the client build-version resource URL for update polling.
./src/contexts/webSocketTransport.test.ts - Focused tests for deployment-prefix-safe build-version URL resolution.
./src/contexts/WebSocketContext.tsx - Polls the client build resource and currently turns nested routes into repeated 404 requests.
./server/modules/providers/list/opencode/opencode-agents.provider.ts - Discovers OpenCode agents by spawning one list command plus one detail process per agent.
./server/modules/providers/services/agents.service.ts - Provider-neutral route service where concurrent identical catalog reads can be coalesced.
./server/modules/providers/tests/opencode-agents.test.ts - Focused OpenCode agent parsing and discovery tests.
./codemaps/backend-agent-provider-cli.md - Backend map that must reflect optimized OpenCode activity and agent catalog behavior.
./codemaps/frontend-chat-session-state.md - Frontend map that must reflect corrected external-refresh ownership.
./codemaps/frontend-app-shell-navigation.md - Frontend shell map that must reflect the activity synchronization request shape.
./codemaps/frontend-pwa-mobile-push.md - PWA map that must reflect root-scoped build-version update polling.
package.json - Defines focused backend/frontend tests, type checks, lint, and build validation.

The running `cloudcli-ui` container was observed at about 212% CPU and 3.8 GiB memory with the long-lived Node server alone retaining about 2.5 GiB RSS; active OpenCode child processes explain part of container usage but not the server retention. The OpenCode database is about 2.9 GiB with 88,188 `part` rows. A direct benchmark of the current activity query (`SELECT data ... FROM part ORDER BY ...`) took about 4.6 seconds and allocated roughly 731 MiB RSS/585 MiB heap in one pass. The application invokes that scan separately from `/sessions/running` and `/sessions/status`, while active-session polling runs every five seconds. Recent logs show those endpoints repeatedly taking roughly 5–14 seconds.

The same ten-minute log window contained 303 transcript `/messages` requests, including bursts every 100–500 ms for one selected session, 38 running requests, 38 status requests, six OpenCode agent catalog requests taking around 30–36 seconds, and 33 nested-route `cloudcli-version.json` 404s. Service workers were not the producer of these requests; update polling comes from `WebSocketContext`, and the build-version URL resolver currently treats a document URL such as `/session/1` as a directory.

The worktree contains unrelated user changes in chat history visibility files and repository documentation. Implementations must preserve those changes and avoid broad rewrites. Backend module standards apply to all server changes. No version-control operations were requested.

## ANALYSIS

The dominant backend performance defect is an unbounded SQLite materialization in `opencode-activity-inspector.provider.ts`. Both inspector functions read every `part.data` JSON blob, sort the full table, parse every row in JavaScript, and the lifecycle variant then performs up to three extra schema/query passes per discovered child. On the live database one scan temporarily allocates hundreds of megabytes. Calling this from two independently polled endpoints creates a near-continuous scan/GC cycle, explaining sustained server CPU, high retained RSS, and multi-second event-loop stalls that delay unrelated HTTP responses.

The safe fix is to make inspection bounded and shared without altering the external running/lifecycle contract. The query should prefilter likely task-tool rows in SQLite, avoid globally sorting/materializing unrelated blobs, batch child-activity lookup instead of issuing per-child table/schema queries, and cache one parsed snapshot briefly using database change identity so `/running`, `/status`, and recovery consumers reuse the same result. The implementation must retain compatibility with known JSON field variants and fail-open behavior for missing, malformed, locked, or old schemas.

The transcript request storm is a separate frontend ownership loop. `useSessionStore` returns a memoized object whose identity changes whenever callback dependencies change, including option-driven stream commits. `useChatSessionState` includes the whole `sessionStore` object in loading and external-refresh effect dependencies; each store tick can therefore re-run the external-update effect while its monotonic signal remains nonzero, producing another canonical refresh. The fix should depend on stable method references and/or consume each external update revision once per session, preserving initial load, watcher-driven refresh, replay recovery, cache hydration, and viewport behavior.

OpenCode agent discovery multiplies expensive CLI startup by spawning `opencode debug agent` concurrently for every discovered agent, and React development/StrictMode or duplicate mounted consumers can issue identical catalog requests. Bounded detail concurrency plus short-lived keyed request/result caching will prevent process storms while keeping manual refresh and workspace-specific catalogs accurate. Mutation paths must invalidate any affected cache.

The client build polling defect is narrower but visible: `new URL('cloudcli-version.json', document.baseURI)` resolves below `/session/` or `/project/<id>/`, causing recurring 404s and preventing update data. The URL must derive from the application/PWA base (manifest or explicit root/subpath base), not the current route leaf.

Service-worker telemetry itself is not expected from `public/sw.js`; the worker handles cache, update, push, and navigation events and does not expose CPU/memory statistics. The reported missing worker data is therefore not evidence that the worker caused the hot loop. Validation should establish reduced query allocation/latency, absence of transcript request repetition, correct catalog coalescing, correct update URL behavior, and clean typecheck/lint/build results. Runtime reload and post-change container/log measurements are required because the original defect is observable only under the live database and browser workload.

## PLAN

1. Replace the full-table OpenCode activity scans with a bounded, batched, short-lived shared snapshot while preserving running/lifecycle/recovery semantics.
2. Stop the selected transcript from repeatedly refreshing for one external update signal by narrowing React dependencies and consuming watcher revisions once.
3. Coalesce and bound OpenCode agent catalog inspection so one page load cannot launch duplicate unbounded CLI process fans.
4. Resolve build-version polling from the application base rather than the active leaf route.
5. Keep deep-route clients and stale pre-fix bundles from repeatedly requesting nested PWA/update resources while the corrected bundle takes control.
6. Rebuild/reload the affected CloudCLI outputs and measure the live runtime against the original CPU, memory, endpoint-latency, and request-rate evidence.

## GUIDELINES

- Preserve all unrelated existing worktree changes; make focused patches and do not reset or rewrite user changes.
- Follow `./.agents/skills/backend-module-standards/SKILL.md` for every server edit: keep routes thin, implementation in the provider/service layer, public exports deliberate, and tests within the Providers module.
- Keep provider-native IDs internal and preserve canonical app-session IDs at API boundaries.
- OpenCode database inspection must remain read-only and fail open for absent, malformed, locked, or older schemas.
- Do not add indexes or mutate the external OpenCode database; optimize CloudCLI's query shape, parsing, batching, and caching only.
- Cache keys must account for workspace/provider scope and relevant source changes; mutations and explicit refresh paths must not return stale agent definitions.
- Frontend fixes must preserve cache hydration, complete canonical history, WebSocket replay recovery, viewport ownership, and watcher-driven external updates.
- Use the deployment/PWA base for static update resources so root and subpath deployments both work.
- Update all affected code maps in the same TODO item as the behavior change.
- Do not branch, stage, commit, push, or otherwise change VCS state.

## TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Optimize OpenCode native activity inspection and its consumers so `/api/providers/sessions/running`, `/api/providers/sessions/status`, and WebSocket recovery no longer perform independent unbounded full-table `part` scans. Implement a read-only shared snapshot keyed by database change identity with a short bounded TTL, prefilter likely Task rows in SQLite, batch child latest-activity lookups, and retain compatibility/fail-open behavior. Update the backend code map.
  **Files:**
  ./server/modules/providers/list/opencode/opencode-activity-inspector.provider.ts - Replace full materialization and per-child queries with bounded shared inspection.
  ./server/modules/providers/services/sessions.service.ts - Consume the optimized shared snapshot without changing canonical API contracts.
  ./server/modules/providers/services/provider-runtime.service.ts - Preserve recovery access to the same optimized child-activity data.
  ./server/modules/providers/tests/opencode-activity-inspector.test.ts - Add focused query-bounding, cache invalidation, and compatibility coverage.
  ./server/modules/providers/tests/sessions.service.test.ts - Verify running/lifecycle snapshots remain correct with shared activity evidence.
  ./codemaps/backend-agent-provider-cli.md - Document the optimized activity snapshot flow and validation.
  **Acceptance criteria:** A live-size activity inspection does not select/materialize every `part.data` row; one database version is parsed once within the bounded cache window across running/status/recovery consumers; child activity timestamps are resolved with bounded batched queries rather than per-child schema scans; missing, malformed, locked, old-schema, terminal, active, nested-field, canonical-parent, and native-ID containment behavior remains correct; `/running` and `/status` no longer each allocate hundreds of MiB or block for multiple seconds on the observed database.
  **Validation:** Run `node --import tsx --test server/modules/providers/tests/opencode-activity-inspector.test.ts server/modules/providers/tests/sessions.service.test.ts server/modules/providers/tests/sessions-status.routes.test.ts`, `npm run typecheck:backend`, and narrow lint for changed server files. Add a reproducible benchmark against the live read-only OpenCode database that reports query duration and memory delta before/after without writing the database.
  **Summary:** Replaced duplicate full-table OpenCode activity scans with one read-only, 2-second database/WAL-identity cache shared by running, lifecycle, and recovery consumers. SQLite JSON predicates now materialize only Task/subtask/subagent rows, and child timestamps use schema discovery once per table plus bounded 400-ID grouped queries. Preserved active/terminal ordering, earliest start/status metadata, nested/legacy identifiers, fail-open behavior, canonical session resolution, and native-ID containment; synchronized the backend code map and added cache invalidation, batching, and prefilter tests. Validation passed: 25 focused tests (with the repository-required `TSX_TSCONFIG_PATH=server/tsconfig.json`), backend typecheck, and narrow ESLint. Live read-only benchmark improved from the recorded ~4.6s/~731 MiB RSS/~585 MiB heap baseline to a 1.61s cold snapshot with 53.8 MiB RSS/21.1 MiB heap delta; immediate running and recovery reuse took 0.9ms/0.4ms with zero measured memory delta. The literal test command cannot resolve `@/` aliases without the repository tsconfig environment.

- [x] **ID:** 2 | **Batch:** 1
  **Task:** Eliminate repeated selected-session transcript refreshes triggered by a single watcher update. Narrow `useChatSessionState` effect dependencies to stable store methods and add per-session external-update consumption/fencing so one monotonic update revision causes at most one canonical refresh while still allowing later revisions, selection changes, and forced replay recovery. Preserve the unrelated history visibility edits already present. Update the frontend chat code map.
  **Files:**
  ./src/components/chat/hooks/useChatSessionState.ts - Fix effect dependency and external-update consumption behavior without overwriting existing visibility changes.
  ./src/stores/useSessionStore.ts - Expose or stabilize only the method-level ownership needed by chat effects if required.
  ./src/hooks/useProjectsState.ts - Preserve watcher revision signaling and adjust only if a more explicit keyed signal is required.
  ./src/hooks/projectStateUtils.ts - Refine revision guards only if needed for one-refresh-per-revision semantics.
  ./src/hooks/projectStateUtils.test.ts - Cover duplicate, later-revision, active-session, and selected-session refresh decisions.
  ./src/components/chat/hooks/sessionMessageLoading.test.ts - Add or extend focused ownership regression coverage where appropriate.
  ./codemaps/frontend-chat-session-state.md - Document corrected external transcript refresh ownership.
  **Acceptance criteria:** One `session_upserted` revision for the viewed inactive session results in no more than one `/messages` refresh even if the session store re-renders repeatedly; a later distinct revision still refreshes; active streaming suppresses watcher refresh; changing sessions cannot apply or repeat a stale update; initial load, warmup, cache hydration, search reveal, replay-gap recovery, and viewport restoration continue to work; existing uncommitted history visibility behavior is preserved.
  **Validation:** Run focused project-state/chat/session-store tests including `node --import tsx --test src/hooks/projectStateUtils.test.ts src/components/chat/hooks/sessionMessageLoading.test.ts src/stores/sessionStore.helpers.test.ts`, `npm run typecheck:frontend`, and narrow lint for changed frontend files. Add a deterministic regression test that simulates repeated store renders after one external update and asserts exactly one refresh.
  **Summary:** Updated `useChatSessionState.ts` to destructure stable session-store methods for loading/external-refresh effects and added a selected-identity revision consumer in `sessionMessageLoading.ts`. Each watcher revision is consumed once, streaming revisions are suppressed rather than retried on render, and selection changes baseline/fence stale revisions. Added deterministic repeated-render/later-revision/streaming/selection tests and synchronized `frontend-chat-session-state.md`. Existing reveal-all code was left intact. Validation passed: 38 focused tests, `npm run typecheck:frontend`, and narrow ESLint with zero warnings.

- [x] **ID:** 3 | **Batch:** 1
  **Task:** Bound and coalesce OpenCode available-agent discovery. Add keyed in-flight/result caching at the provider/service boundary, limit concurrent `opencode debug agent` detail processes, use the lowest-overhead safe CLI options where behavior is equivalent, and invalidate caches after agent definition or preference mutations. Preserve workspace-specific catalogs and manual refresh semantics. Update the backend code map.
  **Files:**
  ./server/modules/providers/list/opencode/opencode-agents.provider.ts - Add bounded detail inspection and source-aware available-agent caching or supporting hooks.
  ./server/modules/providers/services/agents.service.ts - Coalesce identical concurrent route reads and invalidate after mutations as appropriate.
  ./server/modules/providers/tests/opencode-agents.test.ts - Add concurrency, deduplication, ordering, workspace-key, and invalidation coverage.
  ./codemaps/backend-agent-provider-cli.md - Document catalog caching/concurrency behavior and extension points.
  **Acceptance criteria:** Identical concurrent catalog requests for one workspace share one discovery operation; detail subprocess concurrency is explicitly bounded; custom-before-native ordering and descriptions/models/reasoning values remain correct; workspace catalogs do not bleed across paths; agent create/update/delete/preference changes invalidate relevant caches; a caller-requested refresh can obtain fresh data; failures do not permanently poison the cache or leave stale in-flight entries.
  **Validation:** Run `node --import tsx --test server/modules/providers/tests/opencode-agents.test.ts`, `npm run typecheck:backend`, and narrow lint for changed server files. Add timing/concurrency assertions with injected runners rather than relying only on wall-clock CLI execution.
  **Summary:** Added workspace-keyed 15-second successful-result caching and in-flight coalescing in `OpenCodeAgentsProvider`, bounded injected detail inspection to four concurrent processes, exposed explicit `refresh=true` route/service semantics, and invalidated catalogs after successful create/update/delete/preference mutations. Added injected-runner tests for concurrency, coalescing, isolation, refresh, failure recovery, mutation invalidation, ordering, and metadata; synchronized the backend code map and shared list-options contract. Validation passed with 8 focused tests (using the repository backend tsconfig path required for aliases), `npm run typecheck:backend`, and narrow ESLint with zero warnings. The literal validation command lacks the repository's required `TSX_TSCONFIG_PATH=server/tsconfig.json` and therefore cannot resolve `@/` aliases; the equivalent configured command passed.

- [x] **ID:** 4 | **Batch:** 1
  **Task:** Correct client build-version polling so it always requests `cloudcli-version.json` from the application/PWA base instead of the current `/session` or `/project` route directory. Keep root and subpath deployments working and avoid coupling this update check to service-worker telemetry. Update the PWA/frontend shell code maps.
  **Files:**
  ./src/contexts/webSocketTransport.ts - Resolve the build resource from an application base URL.
  ./src/contexts/webSocketTransport.test.ts - Cover root, nested route, trailing slash, and deployment-subpath cases.
  ./src/contexts/WebSocketContext.tsx - Supply the correct base to update polling.
  ./src/lib/pwaRegistration.ts - Reuse the manifest-derived PWA base helper if appropriate without changing worker lifecycle semantics.
  ./codemaps/frontend-pwa-mobile-push.md - Document the corrected update resource path.
  ./codemaps/frontend-app-shell-navigation.md - Document the shell-level build polling behavior if affected.
  **Acceptance criteria:** A page at `/session/:id` requests `/cloudcli-version.json` for a root deployment; a page below `/cloudcli/session/:id` requests `/cloudcli/cloudcli-version.json`; the existing changed-build reload decision and visibility pause remain intact; no recurring nested-route version 404s occur; service-worker registration/update behavior is unchanged.
  **Validation:** Run `node --import tsx --test src/contexts/webSocketTransport.test.ts src/lib/pwaRegistration.test.ts`, `npm run typecheck:frontend`, and narrow lint for changed frontend files.
  **Summary:** Updated `WebSocketContext.tsx` to derive build polling from the existing manifest-based `getPwaBaseUrl`, preserving the polling cadence, hidden-page pause, changed-build reload decision, and all service-worker registration/update code. Updated `webSocketTransport.test.ts` for root/trailing-slash/subpath application bases and synchronized both frontend code maps. Validation passed: 11 focused tests, `npm run typecheck:frontend`, and ESLint on the changed frontend TypeScript files.

- [x] **ID:** 6 | **Batch:** 2
  **Task:** Add a bounded compatibility bridge for nested-route PWA/update resources so stale pre-fix clients at `/session/*` or `/project/*` stop producing recurring `cloudcli-version.json`, `manifest.json`, and `sw.js` 404s while they upgrade to the corrected application-base bundle. Prefer correcting generated install metadata/base resolution and, where needed, serving only these exact root-owned resources through a safe nested-route fallback; do not make arbitrary extension paths return static files. Update backend/PWA maps and focused tests.
  **Files:**
  ./index.html - Make manifest/install metadata resolve from the deployment base rather than the current route directory.
  ./src/lib/pwaRegistration.ts - Make PWA base derivation robust for root/subpath deployments and legacy nested-route documents.
  ./src/lib/pwaRegistration.test.ts - Cover root, nested route, explicit base, and deployment-subpath resolution.
  ./server/index.ts - Add a narrow compatibility fallback only for known PWA/update resource basenames if generated metadata alone cannot rescue stale clients.
  ./server/shared/tests/static-cache-headers.test.ts - Verify compatibility resources retain revalidation headers and unrelated nested asset paths remain 404.
  ./scripts/validation/pwa-install-metadata.test.mjs - Validate deployment-base-safe manifest metadata.
  ./scripts/validation/pwa-built-output.test.mjs - Validate built install metadata and worker shell graph remain coherent.
  ./codemaps/backend-foundations-api-auth.md - Document any narrow static compatibility routing.
  ./codemaps/frontend-pwa-mobile-push.md - Document deployment-base and legacy-client upgrade behavior.
  **Acceptance criteria:** Fresh pages at root and nested routes resolve manifest, service worker, and version resources from the deployment root/subpath; stale clients requesting `/session/cloudcli-version.json` or equivalent known PWA resources receive the correct revalidated root resource instead of a 404; unrelated nested extension requests still return 404; API 404 and static/SPA ordering remain unchanged; worker scope/cache ownership and subpath deployment behavior remain correct.
  **Validation:** Run `node --import tsx --test src/lib/pwaRegistration.test.ts`, `node --test scripts/validation/pwa-install-metadata.test.mjs scripts/validation/pwa-built-output.test.mjs`, `cross-env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/shared/tests/static-cache-headers.test.ts`, frontend/backend typecheck, and narrow lint. Build the client before built-output validation when required.
  **Summary:** Made the source manifest link Vite deployment-base-aware (`%BASE_URL%manifest.json`) and hardened `getPwaBaseUrl` for explicit root/subpath metadata plus a root fallback. Added a narrow post-static compatibility handler that serves only nested `sw.js`, `manifest.json`, and `cloudcli-version.json` from root-owned public/dist files with existing revalidation policy; unrelated nested extensions remain 404 and API/static/SPA ordering is preserved. Added focused root/nested/subpath, built-metadata, cache-header, compatibility, and arbitrary-extension coverage and synchronized both code maps. Validation passed: client build and bundle checks, 3 PWA registration tests, install/built-output validations, 2 backend static-cache tests, frontend/backend typechecks, and narrow ESLint with zero warnings. The literal `cross-env` command was unavailable as a global binary, so the repository-local equivalent was run via `npx cross-env` and passed.

- [x] **ID:** 5 | **Batch:** 3
  **Task:** Rebuild and reload the changed frontend/server outputs, then verify the live `cloudcli-ui` service under the existing workload. Capture post-fix process/container memory and CPU, endpoint latency, request counts, and absence of repeated nested build-version 404s; run the broad validation appropriate to all changed surfaces and fix task-related warnings or regressions.
  **Files:**
  ./package.json - Use repository validation commands for the integrated change set.
  ./plans/fix-runtime-performance-hot-loops.md - Record actual validation and runtime measurements in this item's Summary only.
  **Acceptance criteria:** CloudCLI server/frontend reload successfully; `/sessions/running` and `/sessions/status` respond without the previous 5–14 second full-scan stalls; selected-session `/messages` traffic is event/load driven rather than a 100–500 ms loop; duplicate available-agent process fans are absent; version polling uses the correct resource path; server RSS/CPU show a material reduction after stabilization, accounting separately for intentionally running agent child processes; no new warnings or task-related errors remain.
  **Validation:** Run the cloudcli reload skill with `all`, then `npm run typecheck`, focused tests from IDs 1–4, `npm run lint`, and `npm run build`. Collect `docker stats --no-stream`, `docker top cloudcli-ui`, timed authenticated or browser-driven endpoint observations as available, and a bounded post-reload log sample with counts for `/messages`, `/sessions/running`, `/sessions/status`, `/agents/available`, `cloudcli-version.json` 404s, and watcher events. Do not expose credentials in output.
  **Summary:** Final integrated validation passed after TODO 6: 3 PWA registration tests, 3 install/built-output tests, 2 backend static compatibility/cache tests, `npm run typecheck`, `npm run lint` with zero warnings, and `npm run build` including bundle/chunk budgets. The documented reload skill rebuilt both outputs and restarted the supervised server child from PID 241692 to 247348 without container recreation. After 30 seconds the container used 823 MiB at 3.72% CPU and the server used 213 MiB RSS; a later active-browser sample used 960 MiB at 19.86% with server RSS 331 MiB, while the intentional Architect OpenCode child separately retained 563–583 MiB. Root and nested session/project `cloudcli-version.json`, `manifest.json`, and `sw.js` probes all returned 200 in 1–6 ms; an unrelated nested `/session/arbitrary.js` correctly remained 404. The bounded post-reload interval counted 6 `/messages`, 10 `/sessions/running`, 10 `/sessions/status`, 1 `/agents/available`, and 1 watcher event, with zero root or nested PWA-resource 404s. Message traffic remained event/load driven. Running responses were 1–5 ms; status responses were 140–207 ms cached and 1.7–2.5 seconds after database changes, remaining well below the original 5–14 second stalls. One cold agent catalog request took 12.4 seconds, but no duplicate/unbounded detail process fan was present. All TODO 5 criteria are now met with no task-related warnings or errors.

## CHANGELOG
- 2026-08-19 TODO 4: Build-version polling now resolves `cloudcli-version.json` from the manifest-derived application base; focused tests, frontend typecheck, and narrow lint passed, with service-worker behavior unchanged.
- 2026-08-19 TODO 2: External transcript revisions are now consumed once per selected identity with stable store-method dependencies; repeated-render, later-revision, streaming suppression, and selection-fencing tests plus focused tests, frontend typecheck, and narrow lint passed.
- 2026-08-19 TODO 3: OpenCode available-agent catalogs now coalesce and cache by workspace, bound detail inspection to four processes, support explicit refresh, invalidate after mutations, and recover cleanly from failures; focused tests, backend typecheck, and narrow lint passed.
- 2026-08-19 TODO 1: OpenCode native activity now uses a database-identity-keyed two-second shared snapshot, SQL JSON Task prefiltering, and bounded batched child-activity queries; focused tests, backend typecheck, narrow lint, and the live read-only benchmark passed with a 1.61s/53.8 MiB cold scan and sub-millisecond zero-delta cache reuse.
- 2026-08-19 TODO 5: Integrated typecheck, 82 focused tests, lint, build, and full reload passed; server RSS fell to roughly 209–343 MiB and cached activity endpoints reached millisecond latency, but TODO remains blocked because a stale nested-route client still emitted `/session/cloudcli-version.json` 404s after reload.
- 2026-08-19 TODO 6: Deployment-base manifest metadata and robust PWA base resolution now keep fresh deep links root/subpath-safe; a narrow revalidated compatibility bridge rescues only nested worker/manifest/version requests from stale clients while arbitrary extension 404s and API/static/SPA ordering remain intact. Client build, focused tests, typechecks, and narrow lint passed.
- 2026-08-19 TODO 5 final: Rebuild, integrated validation, and full reload passed after TODO 6; nested/root worker, manifest, and version resources returned 200 with zero sampled PWA 404s, runtime and request-rate improvements remained intact, and all acceptance criteria are complete.
