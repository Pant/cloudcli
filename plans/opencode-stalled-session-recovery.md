# OpenCode Stalled Session Recovery and Controls

## CONTEXT

CloudCLI already indexes OpenCode parent/child sessions, exposes active native Task children, renders recursive sidebar rows, and resumes an indexed OpenCode session by invoking `opencode run --session <provider-id>`. The missing layer is explicit run lifecycle and intent: live state is held in memory, terminal details are discarded after websocket completion, persisted Task rows can remain `running` forever, and no dedicated continuation control exists.

Backend work must follow `AGENTS.md` and `.agents/skills/backend-module-standards/SKILL.md`: behavior belongs in owning services/providers/repositories, routes remain transport-only, cross-module imports use barrels, and tests remain in owning modules. Validation uses focused Node/tsx tests plus typecheck, lint, and the relevant server/client build.

### FILES

./AGENTS.md - Repository guidance requiring the backend module standards skill for all server changes.
./.agents/skills/backend-module-standards/SKILL.md - Architecture, export, route, shared-definition, and backend test requirements for this work.
./server/modules/database/schema.ts - Defines the durable SQLite schema and is the foundation for persisted run intent and terminal status.
./server/modules/database/migrations.ts - Repairs and upgrades existing installations and must create the lifecycle schema idempotently.
./server/modules/database/index.ts - Database module barrel through which lifecycle persistence must be exposed to other modules.
./server/modules/database/repositories/sessions.db.ts - Resolves canonical OpenCode hierarchy and provider IDs needed to scope child status and owning-root recovery.
./server/shared/types.ts - Shared backend lifecycle/status contracts used across database, provider, and websocket modules belong here when reused.
./server/shared/interfaces.ts - Provider runtime diagnostics must extend the existing runtime contract without OpenCode-specific imports at generic call sites.
./server/modules/providers/list/opencode/opencode-activity-inspector.provider.ts - Reads persisted Task/subagent state and currently exposes only active children without freshness or terminal classification.
./server/modules/providers/list/opencode/opencode-runtime.provider.ts - Owns OpenCode subprocesses, abort behavior, process liveness, and output timing used by recovery health checks.
./server/modules/providers/services/provider-runtime.service.ts - Generic runtime dispatcher and the seam for provider-neutral health and abort operations.
./server/modules/providers/services/sessions.service.ts - Builds canonical running snapshots and will expose app-facing lifecycle status without provider-native IDs.
./server/modules/providers/provider.routes.ts - Thin authenticated session routes currently expose running state and will expose lifecycle status.
./server/modules/providers/index.ts - Providers module barrel consumed by server startup and websocket orchestration.
./server/modules/websocket/services/chat-run-registry.service.ts - In-memory run owner that sequences events, prevents duplicate runs, and must coordinate durable generations and progress.
./server/modules/websocket/services/chat-session-writer.service.ts - Gateway writer through which normalized progress and terminal events pass.
./server/modules/websocket/services/chat-websocket.service.ts - Handles send, abort, and subscribe and is the transport seam for explicit manual start/restart.
./server/modules/websocket/index.ts - Websocket module barrel used to expose recovery initialization and shutdown to server startup.
./server/index.ts - Initializes the database, websocket server, watchers, and shutdown services where the recovery watchdog must be started and stopped.
./server/modules/database/tests/sessions.db.integration.test.ts - Existing isolated database test style relevant to lifecycle schema and repository behavior.
./server/modules/providers/tests/opencode-activity-inspector.test.ts - Existing SQLite fixtures for OpenCode Task state variants and fail-open behavior.
./server/modules/providers/tests/opencode-runtime.test.ts - Existing OpenCode subprocess tests to extend for diagnostics and termination behavior.
./server/modules/providers/tests/sessions.service.test.ts - Existing canonical running-child tests to extend for lifecycle classification and native-ID boundaries.
./server/modules/websocket/tests/chat-run-registry.test.ts - Existing registry generation, completion, replay, and duplicate-run coverage.
src/types/app.ts - Frontend session snapshot contracts currently recognize only a loose running status.
./src/hooks/useSessionProtection.ts - Owns the active processing map and must retain a separate lifecycle-status map without corrupting running counts.
./src/components/app/AppContent.tsx - Polls authoritative session state and supplies activity to project/sidebar state.
./src/utils/api.js - Frontend API facade where the session lifecycle endpoint is registered.
./src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx - Joins exact session rows to activity data before rendering.
./src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx - Renders exact/descendant activity and owns desktop/mobile per-session actions.
./src/components/sidebar/types/types.ts - Sidebar prop contracts must carry lifecycle status and a manual start/restart callback.
./src/components/sidebar/hooks/useSidebarController.ts - Produces shared sidebar props and running counts while terminal statuses remain non-running context.
./src/components/chat/view/ChatInterface.tsx - Owns the selected session websocket path and can re-subscribe after an explicit start/restart.
./src/components/chat/types/types.ts - Chat interface contracts must accept lifecycle context if selected-session controls use it.
src/components/chat/tools/components/SubagentContainer.tsx - Contextual Task-box renderer; it currently labels any tool result as completed even when it is an error.
src/components/chat/hooks/useChatMessages.ts - Contextual Task normalization currently derives only running versus result-present completion.
src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx - Existing static sidebar hierarchy/status rendering coverage.
package.json - Defines focused test, typecheck, lint, and build commands used for validation.

## ANALYSIS

The requested behavior needs three states that are currently conflated: whether CloudCLI wants a run to continue, whether a process is actually alive/progressing, and what the latest observable outcome was. Manual stop safety cannot be inferred later from the absence of a process or from a transient `aborted` websocket frame; intent must be recorded durably before aborting. Likewise, automatic recovery cannot safely depend only on `startedAt`: OpenCode root output can be quiet while a nested Task is making progress, so health must combine registry events, subprocess output, and persisted child/session update times.

The durable model should be one current run-state record per canonical session with a monotonically increasing generation. It needs desired state (`running` or `stopped`), lifecycle state, timestamps, exit/terminal reason, bounded recovery count, and sanitized continuation options. Generation-guarded writes preserve the registry's existing old-run/new-run safety: a late terminal callback from a killed process cannot overwrite the manually or automatically restarted generation. Successful completion ends desired running intent; a user abort records manual stop before signaling the process; unexpected disappearance or a health timeout remains recovery-eligible until the bounded policy is exhausted.

Automatic recovery should be conservative and OpenCode-only. A configurable watchdog should use a generous default inactivity threshold, skip runs with pending approvals, merge last registry event time with OpenCode subprocess output and native descendant activity, and require a durable desired-running record. Recovery should fence/terminate the old process, continue the same canonical/provider session with no fabricated user message, retain safe session model/agent/runtime options, and cap retries with backoff. Server restart recovery follows the same rule: a durable desired-running generation with no live registry/process evidence is eligible, while `manually_stopped` never is. SIGTERM should have bounded escalation so a hung process does not survive beside its replacement.

Manual start/restart should reuse the same execution service as `chat.send`, exposed through a websocket command so the requesting socket can immediately receive output and later reconnect/replay normally. An idle indexed child can be continued directly using its canonical ID; a restart request that belongs to a still-active owning lineage must avoid concurrent OpenCode ownership by safely replacing the owning run rather than spawning a conflicting duplicate. Explicit manual start clears prior manual-stop intent by creating a new generation, but automatic logic never clears it.

Status reporting should remain separate from the exact processing map. The backend can retain `/sessions/running` for compatibility and add a lifecycle snapshot that merges durable root state with latest OpenCode Task state. App-facing statuses should distinguish running, recovering, stalled, exited/not-running, failed, and manually stopped, carry last activity and restartability, and resolve every child/provider ID to canonical CloudCLI IDs. Persisted `completed` Task rows may simply clear active failure markers; stale `running` rows under a live owner are stalled, while the same stale evidence under an absent/terminal owner is exited. The response should remain bounded and fail open on incompatible OpenCode databases.

On the frontend, active running/recovering sessions continue to drive spinners, forced hierarchy expansion, archive protection, and running counts. A separate lifecycle map supplies exact-row status badges/tooltips and Start/Restart actions without treating exited or stopped sessions as active agents. The sidebar is the reliable surface because every indexed subagent already has a canonical nested row; modifying the Task/thinking box is optional and should only occur when a canonical child binding is available. At minimum, the existing Task box must stop presenting error results as green completion if touched.

Primary risks are false-positive stall detection during legitimate long tasks, duplicate processes during recovery, stale terminal callbacks, restart loops caused by configuration/auth failures, provider-native ID leakage, and frontend running counts accidentally including terminal states. Conservative timeout/backoff defaults, pending-approval exclusion, generation fencing, OpenCode-only automatic policy, canonical repository resolution, and focused failure/race tests address those risks. No repository-external product decision blocks implementation; defaults can be configurable through environment variables and documented in code.

## PLAN

1. Add durable, generation-aware run lifecycle persistence so desired-running intent, manual stops, progress, terminal reasons, and bounded recovery attempts survive websocket loss and server restarts.
2. Extend OpenCode diagnostics to expose subprocess liveness/output timing and provider-database child lifecycle/freshness, with bounded termination and fail-open schema handling.
3. Centralize run execution behind a reusable lifecycle service, route normal sends and manual starts through it, and run a conservative OpenCode watchdog that restarts stalled roots/children but never a manually stopped generation.
4. Expose canonical lifecycle snapshots for OpenCode roots and nested children, separating exact active processing from stalled, exited, failed, recovering, and manually stopped status.
5. Poll and retain lifecycle state in the frontend, render explicit nested-session status in the sidebar, and provide accessible manual Start/Restart actions without inflating running-agent counts.

## GUIDELINES

- Confine edits and commands to `/home/dev/code/cloudcli-src`; do not perform VCS operations or alter unrelated working-tree changes.
- Read and follow ./AGENTS.md and ./.agents/skills/backend-module-standards/SKILL.md before every backend item. Keep routes transport-only, put orchestration in owning services, expose cross-module behavior through barrels, and place tests in owning modules.
- Use canonical CloudCLI `session_id` values at every browser/API boundary. OpenCode provider-native session and parent IDs remain inside provider/database code and must never appear in lifecycle payloads, logs intended for clients, or UI labels.
- Persist run intent by generation. Every new user send, explicit manual start, or automatic recovery creates or claims a new generation; terminal/progress writes from an older generation must be ignored.
- Record manual stop intent before attempting provider termination. A generation marked manually stopped is never automatically restarted, including after backend restart or when stale OpenCode Task rows still say `running`.
- Automatic recovery is OpenCode-only and conservative. Use meaningful progress/liveness evidence rather than `startedAt` alone, skip pending approval waits, use configurable generous inactivity/backoff defaults, cap attempts, and expose recovery exhaustion as a visible failure instead of looping.
- Treat OpenCode root output, subprocess state, Task-part updates, child session/message/part updates, and registry events as complementary evidence. Missing/incompatible/locked provider databases fail open and must not break running/status APIs or the watchdog.
- Fence or terminate a stale process before replacing the same canonical run. OpenCode abort must use bounded SIGTERM-to-SIGKILL escalation and retain enough process-map evidence to confirm liveness instead of deleting the handle optimistically.
- Manual start/restart continues the existing provider-native session with no fabricated user-visible message and uses the same service path as normal `chat.send`. Retain safe persisted model, effort, agent, permission, and project/cwd options; do not persist or replay attachments from old turns.
- A directly started nested child is tracked under its own canonical app ID, can be interrupted as its own CloudCLI run, and must not be duplicated if an active registry/recovery generation already owns it.
- Keep active processing and lifecycle status separate on the frontend. Only `running` and `recovering` exact sessions participate in processing maps, running counts, forced expansion, archive protection, or stop controls; terminal/stalled badges are context only.
- Lifecycle responses should be bounded to actionable/current states. Normal completed historical sessions need no persistent warning badge; stale active Task state, explicit failure, manual stop, recovery exhaustion, or recovering state remains visible until superseded by a new generation/provider update.
- Render clear, accessible status text and controls in nested sidebar rows on desktop and mobile. Use `role="status"`, tooltips/ARIA labels, non-color-only distinctions, and localized English strings following existing sidebar conventions.
- Preserve existing hierarchy, pagination, tri-state parent resolution, running ancestor hydration, queued message behavior, provider-neutral chat behavior, websocket replay, exact-one-complete handling, and old-run/new-run safety.
- Each TODO item adds and runs focused tests for its behavior, followed by practical typecheck/lint/build checks for its scope. Frontend tests require explicit `node --import tsx --test ...`; backend alias tests may require `TSX_TSCONFIG_PATH=server/tsconfig.json`.

## TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Add generation-aware durable run lifecycle persistence. Create an additive `session_run_state` schema and idempotent migration plus an owning repository that can atomically begin a user/manual/recovery generation, update meaningful progress only for the current generation, request manual stop before abort, record terminal outcomes, mark stalled/recovering/recovery-exhausted state, schedule bounded attempts/backoff, and list current recoverable/actionable states. Store canonical session ids, provider, desired state, lifecycle state, timestamps, exit/terminal reason, restart count, and a sanitized JSON continuation-options payload; do not persist attachments or provider-native IDs. Export only the required repository and shared lifecycle contracts through module barrels.
  **Files:**
  ./AGENTS.md - Repository-wide backend guidance the implementation must follow.
  ./.agents/skills/backend-module-standards/SKILL.md - Required backend architecture, shared type, export, route, and test rules.
  ./server/modules/database/schema.ts - Add the durable lifecycle table and indexes to fresh schema initialization.
  ./server/modules/database/migrations.ts - Add idempotent lifecycle table/index creation for upgraded installations.
  ./server/modules/database/repositories/session-run-state.db.ts - New owning repository for generation-guarded lifecycle and recovery state transitions.
  ./server/modules/database/index.ts - Export the lifecycle repository for websocket/provider consumers.
  ./server/shared/types.ts - Define reused documented lifecycle state, terminal reason, continuation options, and app-facing record contracts.
  ./server/modules/database/tests/session-run-state.db.test.ts - Add isolated lifecycle repository and migration coverage.
  server/modules/database/repositories/sessions.db.ts - Contextual canonical session repository whose ids and provider ownership the lifecycle state references.
  **Acceptance criteria:** Fresh and migrated databases contain the lifecycle schema; beginning a run increments generation and sets desired running; stale-generation progress/terminal writes are no-ops; manual stop is durable before abort and excludes recovery; successful completion clears desired running; failure/exited/stalled/recovering/recovery-exhausted states retain actionable metadata; retry claims are atomic and bounded; sanitized options retain safe continuation settings but exclude attachments and native IDs; repository consumers import through the database barrel.
  **Validation:** Add focused tests for migration idempotency, generation fencing, manual-stop precedence, terminal transitions, retry/backoff bounds, restart-after-manual-stop only through a new explicit generation, and continuation-option sanitization. Run `TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/database/tests/session-run-state.db.test.ts`, relevant existing database integration tests, `npm run typecheck`, targeted backend lint, and `npm run build:server`.
  **Summary:** Added the fresh-schema and idempotent migration definitions for `session_run_state`, shared documented lifecycle contracts, and a database-barrel-exported owning repository with generation-fenced begin/progress/terminal/manual-stop operations, bounded atomic recovery claims, actionable/recoverable listings, and safe continuation-option allow-listing. Added focused repository/migration tests; no changes were needed in the contextual canonical sessions repository.

- [x] **ID:** 2 | **Batch:** 1
  **Task:** Add OpenCode runtime and persisted-child health diagnostics. Extend subprocess tracking with started/last-output timestamps, positive liveness checks, and bounded SIGTERM-to-SIGKILL abort confirmation while preserving exact-one-complete behavior. Expand the read-only OpenCode activity inspector into a latest Task/subagent lifecycle snapshot that reports active/terminal state, task update time, child session/message/part activity time, and provider-native child binding for backend-only canonical resolution. Keep current active-child compatibility and old/malformed/locked database fail-open behavior.
  **Files:**
  ./AGENTS.md - Repository-wide backend guidance the implementation must follow.
  ./.agents/skills/backend-module-standards/SKILL.md - Required backend architecture and provider test rules.
  ./server/modules/providers/list/opencode/opencode-runtime.provider.ts - Owns OpenCode process handles, output events, abort, and runtime diagnostics.
  ./server/modules/providers/list/opencode/opencode-activity-inspector.provider.ts - Owns read-only persisted Task/subagent lifecycle and freshness inspection.
  ./server/modules/providers/tests/opencode-runtime.test.ts - Extend subprocess lifecycle, diagnostics, and abort escalation coverage.
  ./server/modules/providers/tests/opencode-activity-inspector.test.ts - Extend SQLite fixtures for update freshness, child activity, terminal states, and compatibility.
  server/modules/providers/list/opencode/opencode-sessions.provider.ts - Contextual current OpenCode message/part schema and timestamp normalization patterns.
  **Acceptance criteria:** Runtime diagnostics distinguish missing, alive, and exited processes and expose last output without leaking process internals to the browser; stdout and stderr refresh progress; abort waits for exit and escalates after a bounded timeout; process-map cleanup occurs on actual close/error and duplicate completes remain suppressed; activity inspection returns latest pending/running/completed/error/cancelled state with reliable last activity from task/child records; current `listOpenCodeRunningChildSessions` behavior remains compatible; incompatible databases return empty snapshots without throwing.
  **Validation:** Add focused runtime mocks for output timing, normal close, SIGTERM success, SIGKILL escalation, failed/missing process, and duplicate terminal suppression; add SQLite fixtures for task update versus child progress, terminal replacement, nested/current/legacy metadata, missing child rows, old schemas, malformed JSON, and locked/missing files. Run the two focused provider test files with backend tsconfig aliases, `npm run typecheck`, targeted backend lint, and `npm run build:server`.
  **Summary:** Extended OpenCode process records with sanitized missing/alive/exited diagnostics, start/output timing, actual-event cleanup, and asynchronous bounded SIGTERM-to-SIGKILL abort confirmation while retaining duplicate-complete suppression. Added latest persisted Task child lifecycle snapshots with terminal states and task/session/message/part freshness, preserving the active-child API and fail-open compatibility. Extended focused tests for diagnostics and terminal snapshot replacement; all scoped tests, lint, typecheck, and server build pass.

- [x] **ID:** 3 | **Batch:** 2
  **Task:** Centralize run execution and implement manual plus automatic recovery. Add a websocket-owned lifecycle/orchestration service used by `chat.send` and a thin authenticated `POST /api/providers/sessions/:sessionId/start` action. The service must create durable generations, build sanitized continuation options from the session/current request, support detached background writers that buffer until `chat.subscribe`, record progress and terminal reasons, and preserve duplicate-run/current-generation guards. Add an OpenCode watchdog initialized at server startup that evaluates durable desired-running roots and native children against registry/runtime/inspector health, skips pending approvals and manually stopped generations, marks stalled/recovering state, performs bounded backoff recovery with empty session continuation, and exposes clean shutdown. Ensure direct child recovery/manual start uses its canonical child ID and OpenCode provider session mapping.
  **Files:**
  ./AGENTS.md - Repository-wide backend guidance the implementation must follow.
  ./.agents/skills/backend-module-standards/SKILL.md - Required backend architecture, route, barrel, and service rules.
  ./server/modules/database/index.ts - Consume the lifecycle repository implemented by Item 1.
  ./server/shared/types.ts - Consume Item 1 lifecycle and continuation contracts.
  ./server/modules/providers/list/opencode/opencode-runtime.provider.ts - Consume Item 2 process health and bounded termination diagnostics.
  ./server/modules/providers/list/opencode/opencode-activity-inspector.provider.ts - Consume Item 2 native child lifecycle/freshness snapshots.
  ./server/modules/providers/services/provider-runtime.service.ts - Expose provider-neutral health/abort operations needed by orchestration without route-level provider imports.
  ./server/modules/providers/index.ts - Export only recovery-required provider service contracts to startup/websocket modules.
  ./server/modules/providers/provider.routes.ts - Add the thin authenticated manual start route that validates the canonical session id and delegates once.
  ./server/modules/websocket/services/chat-session-writer.service.ts - Support detached buffering before a browser connection attaches.
  ./server/modules/websocket/services/chat-run-registry.service.ts - Track run generation/progress and retain replay/current-run fencing for normal and recovered runs.
  ./server/modules/websocket/services/chat-run-lifecycle.service.ts - New owning service that starts normal, manual, and recovery runs through one execution path.
  ./server/modules/websocket/services/opencode-run-recovery.service.ts - New conservative watchdog for stale OpenCode roots and native children.
  ./server/modules/websocket/services/chat-websocket.service.ts - Delegate `chat.send` and manual abort lifecycle transitions while preserving protocol validation/subscription behavior.
  ./server/modules/websocket/index.ts - Export recovery initialization/shutdown and lifecycle service APIs needed across modules.
  ./server/index.ts - Start the watchdog after database/server initialization and stop it during shutdown.
  ./server/modules/websocket/tests/chat-run-registry.test.ts - Extend generation, detached replay, progress, and old-run fencing tests.
  ./server/modules/websocket/tests/chat-run-lifecycle.test.ts - Add focused normal/manual start, stop intent, and terminal orchestration tests.
  ./server/modules/websocket/tests/opencode-run-recovery.test.ts - Add watchdog health, retry, child recovery, server-restart, and manual-stop exclusion tests.
  server/modules/providers/services/sessions.service.ts - Contextual canonical/provider session resolution used by runtime continuation.
  **Acceptance criteria:** Normal chat sends still stream/replay and persist model/agent behavior through the centralized service; manual Start on an idle root or child starts a tracked canonical run without adding a user message; detached starts buffer until subscribe; manual abort persists stop intent before termination and can never auto-recover that generation; stale OpenCode roots and stale native children auto-recover once eligible; recent progress and pending approvals prevent recovery; attempts are generation-fenced, bounded, and backed off; old process callbacks cannot finish a replacement; recovery survives backend registry loss through durable desired-running state; watchdog initialization/shutdown does not keep tests/processes alive.
  **Validation:** Add and run focused lifecycle/recovery/registry tests for normal sends, detached manual child start, subscribe replay, manual stop before failed abort, recent versus stale evidence, pending approvals, stale child under a live root, server-restart reconciliation, attempt exhaustion, double-watchdog claim prevention, and late old-generation completion. Run relevant existing websocket/provider runtime tests, `npm run typecheck`, targeted backend lint, and `npm run build:server`.
  **Summary:** Added centralized durable run orchestration, detached writer/registry generation-progress fencing, manual start and stop-intent-before-abort delegation, provider-neutral OpenCode health/child inspection, and an unref'ed startup/shutdown recovery watchdog with bounded atomic claims. Added focused lifecycle tests for normal options/stream/terminal persistence, detached canonical child continuation/replay, and failed-abort manual-stop precedence; added recovery tests for recent evidence, approvals, stale root/child restart after backoff, registry-loss reconciliation, atomic concurrent claims, manual-stop exclusion, exhaustion, and clean shutdown; extended registry coverage for detached generation/progress/replay and late old-run fencing. All focused tests, typecheck, targeted lint, and server build pass without implementation fixes.

- [x] **ID:** 4 | **Batch:** 2
  **Task:** Expose canonical session lifecycle status for roots and nested OpenCode children. Add a provider service method and thin `GET /api/providers/sessions/status` route that merges durable run state from Item 1 with Item 2's latest native Task lifecycle, registry/root ownership, canonical session/project/parent summaries, and inactive ancestor context. Classify actionable states as running, recovering, stalled, exited, failed, manually stopped, or recovery exhausted; omit normal completed history; mark restartability and interruptibility accurately; retain the existing `/sessions/running` contract for exact active processing.
  **Files:**
  ./AGENTS.md - Repository-wide backend guidance the implementation must follow.
  ./.agents/skills/backend-module-standards/SKILL.md - Required backend service, route, export, and test rules.
  ./server/modules/database/index.ts - Consume current durable lifecycle records from Item 1.
  ./server/modules/database/repositories/sessions.db.ts - Resolve provider-native child ids and canonical hierarchy/project rows.
  ./server/modules/providers/list/opencode/opencode-activity-inspector.provider.ts - Consume Item 2 latest Task state and freshness.
  ./server/modules/providers/services/sessions.service.ts - Build bounded canonical lifecycle snapshots alongside the existing running snapshots.
  ./server/modules/providers/provider.routes.ts - Add the thin static status route before generic session-id routes.
  ./server/shared/types.ts - Reuse the shared lifecycle state contract from Item 1.
  ./server/modules/providers/tests/sessions.service.test.ts - Extend canonical lifecycle merge, ancestry, and native-ID boundary coverage.
  ./server/modules/providers/tests/sessions-status.routes.test.ts - Add thin route response and ordering coverage.
  **Acceptance criteria:** Active registry roots and directly recovered children report running/recovering; stale active Task evidence reports stalled while its owner remains viable and exited when no active/recoverable owner exists; persisted error/cancel/manual-stop/recovery-exhausted states are distinct; manual and stalled/exited/failed statuses are restartable, only exact tracked runs are interruptible, normal completed children disappear from actionable status, shared ancestors are canonical/deduplicated context, unknown native children and incompatible DBs fail open, and provider-native IDs never cross the API.
  **Validation:** Add focused service/route tests for root and nested child classification, fresh versus stale activity, owner disappearance, durable state precedence, manual-stop precedence over stale Task rows, direct child recovery collision, shared ancestor context, cycles/orphans, bounded results, non-OpenCode compatibility, and native-ID leakage. Run the focused provider tests plus existing running-session tests, `npm run typecheck`, targeted backend lint, and `npm run build:server`.
  **Summary:** Added browser-safe canonical lifecycle snapshot contracts, a bounded provider service merge of registry runs, durable lifecycle records, OpenCode Task freshness/terminal evidence, ownership viability, and deduplicated inactive ancestors, plus the static thin `/sessions/status` route. Extended service and route tests for precedence, child classification, ancestry, completed omission, and provider-native ID boundaries; focused tests, typecheck, targeted lint, and server build pass.

- [x] **ID:** 5 | **Batch:** 3
  **Task:** Add frontend lifecycle state, nested status rendering, and manual Start/Restart controls. Add typed lifecycle snapshots and a separate session-status map to `useSessionProtection`; poll `/sessions/status` with the existing five-second activity refresh and merge canonical context into projects without putting terminal/stalled rows into the processing map. Carry exact lifecycle state through sidebar props, render accessible state-specific indicators/text for recovering, stalled, exited, failed/recovery-exhausted, and manually stopped rows on desktop/mobile, and add a Start/Restart action for idle/restartable OpenCode root or child rows that calls the manual start API. Preserve exact running counts, forced expansion, delete protection, hierarchy interactions, provider-id copy, and flat provider behavior.
  **Files:**
  ./src/types/app.ts - Define app-facing lifecycle status, terminal metadata, restartability, and canonical snapshot/context types.
  ./src/hooks/useSessionProtection.ts - Retain a lifecycle-status map separately from exact processing activity and provide authoritative sync helpers.
  ./src/components/app/AppContent.tsx - Poll running plus lifecycle status, parse canonical snapshots, merge context, and expose both maps to sidebar state.
  ./src/utils/api.js - Add the lifecycle status and manual session start API calls.
  ./src/components/sidebar/types/types.ts - Carry lifecycle map and manual start callback through sidebar contracts.
  ./src/components/sidebar/hooks/useSidebarController.ts - Preserve active counts while exposing lifecycle state/actions to rendered project rows.
  ./src/components/sidebar/view/Sidebar.tsx - Pass lifecycle state and start callback through the active sidebar rendering chain.
  ./src/components/sidebar/view/subcomponents/SidebarContent.tsx - Preserve running search/count behavior while plumbing lifecycle props.
  ./src/components/sidebar/view/subcomponents/SidebarProjectList.tsx - Pass lifecycle state and actions to project/session rendering.
  ./src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx - Pass lifecycle state and actions to expanded project sessions.
  ./src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx - Join exact row lifecycle state to each flattened hierarchy row.
  ./src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx - Render desktop/mobile status, Start/Restart actions, loading/error feedback, and existing menus/interactions accessibly.
  ./src/i18n/locales/en/sidebar.json - Add clear status, tooltip, and manual action labels.
  ./src/hooks/useSessionProtection.test.ts - Add pure/state-harness coverage for active versus terminal lifecycle reconciliation.
  ./src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx - Extend nested status rendering and count/action coverage.
  src/hooks/projectStateUtils.ts - Contextual existing canonical running-snapshot hydration that lifecycle context should reuse rather than duplicate.
  **Acceptance criteria:** A nested subagent row visibly distinguishes running, recovering, stalled, exited/not-running, failed/recovery-exhausted, and manually stopped; normal completed rows have no warning state; only exact running/recovering sessions contribute to processing/running counts and archive protection; stalled/exited/failed/manual rows offer an accessible Start/Restart action; clicking it starts the canonical session without selecting/toggling accidentally, shows pending/error feedback, and the next poll transitions it to recovering/running; desktop and mobile behavior match; existing hierarchy, running-mode ancestor context, row selection/disclosure, copy, rename, archive/delete, and non-OpenCode rows remain intact.
  **Validation:** Add focused lifecycle-state tests for authoritative polling, terminal status retention/removal, running-map separation, and stale snapshots; extend sidebar static/interaction tests for every state, labels/ARIA, manual action callback/loading/error, exact counts, descendant context, and event propagation. Run the new tests plus existing hierarchy/project-state/sidebar tests, `npm run typecheck`, targeted frontend lint, and `npm run build:client`.
  **Summary:** Added typed canonical lifecycle contracts and an authoritative lifecycle map separate from processing activity; AppContent now polls running/status together, hydrates canonical lifecycle context through the existing project-state merge, and exposes manual start. Plumbed lifecycle/actions through sidebar contracts and rendered accessible desktop/mobile state labels plus non-propagating Start/Restart controls with pending/error feedback while preserving active-only counts/protection. Added focused lifecycle reconciliation and nested sidebar coverage; focused hierarchy/project-state/sidebar tests, typecheck, targeted frontend lint, and client build pass.

- [x] **ID:** 6 | **Batch:** 4
  **Task:** Add a non-destructive recovery smoke validation and run the complete practical regression set. Create a production-shaped script using copied CloudCLI/OpenCode SQLite fixtures that seeds a running root, a stale nested Task child, a manually stopped child, and an exited child; initialize current schema/services with short test-only recovery thresholds and mocked runtime dispatch; assert exactly the eligible stalled child is recovered, manual-stop intent is preserved, lifecycle API output is canonical, and manual start creates a new generation. Add a package script and run backend/frontend focused regressions, typecheck, lint, and both builds.
  **Files:**
  ./scripts/validation/opencode-session-recovery-smoke.mjs - New non-destructive copied-database lifecycle/recovery validation.
  ./package.json - Register a repeatable recovery validation command.
  ./scripts/validation/nested-session-smoke.mjs - Existing copied-database validation pattern to reuse without mutating live data.
  ./plans/opencode-stalled-session-recovery.md - Update only Item 6 status/Summary and append its changelog entry after validation.
  server/modules/database/schema.ts - Contextual built lifecycle schema artifact asserted by the smoke.
  server/modules/websocket/services/opencode-run-recovery.service.ts - Contextual watchdog behavior exercised with short test-only timing.
  server/modules/providers/services/sessions.service.ts - Contextual canonical lifecycle serialization asserted by the smoke.
  src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx - Contextual built UI status/action artifact asserted after the client build.
  **Acceptance criteria:** The smoke uses only temporary/copied databases and no live process termination; stale eligible work recovers once, recent work does not, manually stopped work never auto-recovers, exited status is visible, explicit manual start creates a new desired-running generation, canonical ids are used throughout, provider-native ids do not leak, timers/services shut down cleanly, and deployable client/server builds contain the recovery/status implementation.
  **Validation:** Run the new package validation script, all focused backend/frontend tests added in Items 1-5 plus relevant existing nested-session/registry/runtime/sidebar tests, `npm run typecheck`, `npm run lint -- --quiet` (or the closest supported command, reported precisely), and `npm run build`. Inspect built artifacts for lifecycle schema, watchdog/status route, and sidebar status/action strings.
  **Summary:** Added `scripts/validation/opencode-session-recovery-smoke.mjs` and the repeatable `validate:opencode-session-recovery` package command. The smoke creates and copies only temporary SQLite fixtures, seeds canonical root/stale/recent/manual/exited lifecycle cases, mocks runtime execution without process termination, validates exactly-once stale recovery, recent/manual exclusions, exited canonical serialization with no native-id leakage, explicit manual generation restart, and clean registry/database/watchdog shutdown. The full build-backed smoke, 63 focused backend tests, 29 focused frontend/nested/sidebar tests, typecheck, ESLint quiet mode, and deployable artifact inspections all passed; no production implementation fixes were required.

## CHANGELOG

- **2026-08-07 — Item 1:** Added durable generation-aware session lifecycle schema/migrations, shared contracts, barrel-exported repository transitions and recovery claims, plus focused migration, fencing, stop-precedence, terminal, retry, restart, and sanitization tests.
- **2026-08-07 — Item 2:** Added sanitized OpenCode subprocess health/output diagnostics, bounded confirmed abort escalation, persisted Task child lifecycle/freshness snapshots, compatibility preservation, and focused provider tests.
- **2026-08-07 — Item 4:** Added bounded canonical session lifecycle snapshots and the static status route, merging durable, registry, OpenCode Task freshness/terminal, ownership, restart/interrupt, and deduplicated ancestor context without native-ID leakage, with focused service/route coverage.
- **2026-08-07 — Item 3:** Added centralized durable run orchestration, detached generation-aware registry/writers, manual start/stop lifecycle handling, provider-neutral OpenCode diagnostics, and a bounded unref'ed recovery watchdog; marked incomplete because required focused lifecycle/recovery tests were not added.
- **2026-08-07 — Item 3 follow-up:** Added and passed focused lifecycle, detached replay/generation fencing, manual-stop precedence, stale/recent/approval evidence, root/child restart, registry-loss, backoff/exhaustion, concurrent-claim, late-callback, and watchdog shutdown tests; typecheck, targeted lint, runtime/registry regressions, and server build pass.
- **2026-08-07 — Item 5:** Added separate authoritative frontend lifecycle polling/state, canonical context hydration, accessible nested sidebar lifecycle labels and manual Start/Restart controls with pending/error feedback, active-only counts/protection, and focused passing frontend tests/build validation.
- **2026-08-07 — Item 6:** Added a copied-temporary-database OpenCode lifecycle/recovery smoke and package command; validated exactly-once eligible recovery, recent/manual exclusions, exited canonical status, manual generation restart, clean shutdown, focused backend/frontend regressions, quiet lint, typecheck, full builds, and deployable lifecycle/watchdog/sidebar artifacts.
