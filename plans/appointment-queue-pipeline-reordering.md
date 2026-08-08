# CONTEXT

## FILES

./AGENTS.md - Repository guidance requires the backend module standards skill for every change under `server/`.
./.agents/skills/backend-module-standards/SKILL.md - Backend architecture rules require thin routes, public barrels, shared multi-use contracts, and module-scoped tests.
./server/shared/types.ts - Shared appointment records and trigger/status contracts must expose durable queue ordering and launched-run identity.
./server/modules/database/schema.ts - The fresh-install appointments table and indexes are defined here.
./server/modules/database/migrations.ts - Existing installations receive idempotent appointment schema upgrades here.
./server/modules/database/repositories/appointments.db.ts - Appointment persistence, scheduler queries, atomic claims, and project/user list ordering are implemented here.
./server/modules/database/tests/appointments.db.test.ts - Focused SQLite coverage verifies migrations, persistence, scoped reads, and conditional scheduler mutations.
./server/modules/database/index.ts - Appointments and run-state repositories are consumed by feature modules through this public barrel.
./server/modules/appointments/appointments.service.ts - Project/session ownership, appointment creation, and management business rules live here.
./server/modules/appointments/appointments.routes.ts - The authenticated project-scoped appointment HTTP surface is parsed here.
./server/modules/appointments/appointments.module.ts - Production appointment repository, run-state, registry, lifecycle, and scheduler dependencies are assembled here.
./server/modules/appointments/appointment-scheduler.service.ts - Due and project-idle appointments are selected and launched here, but launch acceptance is currently treated as completion.
./server/modules/appointments/tests/appointments.routes.test.ts - Route and service behavior is covered through a focused in-process Express server.
./server/modules/appointments/tests/appointment-scheduler.service.test.ts - Scheduler dispatch, deferral, idle, quarantine, and failure behavior is covered here.
./server/modules/websocket/index.ts - Appointment code may consume run lifecycle and registry behavior only through this module barrel.
./server/modules/websocket/services/chat-run-lifecycle.service.ts - Detached starts return the durable run generation immediately while provider execution continues asynchronously.
./server/modules/websocket/services/chat-run-registry.service.ts - Live project/session activity and run generations can be inspected through the registry.
./server/modules/database/repositories/session-run-state.db.ts - Durable generation and terminal lifecycle state allow a launched appointment to be finalized only after its actual run finishes.
./src/components/chat/types/appointments.ts - Browser appointment contracts need the queue trigger, queue position, and launched-run metadata returned by the API.
./src/utils/api.js - Authenticated appointment methods need a project-scoped queue reorder operation.
./src/components/chat/view/subcomponents/PromptAppointmentModal.tsx - The appointment form and management list are the user-facing surface for adding queue entries and reordering the pipeline.
./src/components/chat/view/subcomponents/PromptAppointmentModal.utils.ts - Testable trigger request and ordering helpers belong here.
./src/components/chat/view/subcomponents/PromptAppointmentModal.test.tsx - Static and utility coverage verifies queue creation and accessible pipeline reordering states.
./src/components/chat/view/ChatInterface.tsx - This component loads and refreshes project appointments for the modal and is contextual to reorder refresh behavior.
./src/i18n/locales/en/chat.json - English queue, pipeline, ordering, and management copy belongs in the existing appointments namespace.
./package.json - Focused Node tests, TypeScript builds, typecheck, and ESLint commands define validation.

# ANALYSIS

The request adds a durable queue to project prompt appointments and calls the ordered queue a pipeline that the user can reorder. The narrowest coherent model is a fourth appointment trigger, `queue`: creating one appends it to the authenticated user's project pipeline, and active queue entries run one at a time in durable `queuePosition` order after the project has no live or recoverable run in progress. Exact, timer, and project-idle appointment semantics remain available and are not implicitly reordered.

Queue order must live in SQLite rather than the browser because appointments already survive browser and server restarts. The appointments table therefore needs nullable `queue_position` and `run_generation` columns. Queue positions apply only to `queue` rows and are allocated at creation using the next position in the project/user scope. A transactional reorder operation should accept the complete ordered ID list of mutable queue rows, reject duplicates, foreign/non-queue IDs, and stale/incomplete sets, and rewrite contiguous positions atomically. Running queue entries are pinned and cannot be moved; draft and scheduled queue entries remain reorderable. Cancelled, completed, and failed history is not part of the active pipeline.

The current scheduler awaits `chatRunLifecycleService.start`, but that promise resolves once a provider run is launched, not when it completes; it consequently marks appointments completed too early. A real pipeline cannot safely advance on launch acceptance. After claiming an appointment, the scheduler should persist the returned generation and leave the row `running`. Subsequent ticks reconcile running appointments against the durable session run state for that exact generation: completed runs complete the appointment, failure/recovery-exhausted/manual-stop outcomes fail it with available detail, and active/recoverable states keep it running. This truthful finalization should apply to all appointment trigger types so status behavior is internally consistent, while queue selection additionally waits for project activity to clear and dispatches at most one queue entry per project during a tick.

Restart safety requires more than the in-memory registry. A queued appointment must not launch merely because the process restarted and the live registry is empty while a durable session run remains desired/running or recoverable. The production scheduler should therefore receive durable actionable run states through the database barrel and resolve their sessions to project paths when building the set of busy projects. A previously launched running appointment can then resume polling its recorded generation after restart instead of being duplicated. Project-idle startup quarantine remains unchanged.

The API needs one authenticated project-scoped reorder endpoint. The service owns ownership, membership, exact-set, and status validation; the route only parses an array of IDs and returns normalized rows. The frontend can optimistically display the requested order only while the request is pending, but should refresh from the server after success and retain/show the server order on failure. No drag-and-drop dependency exists in the repository, and mobile/keyboard accessibility is required, so explicit Move up and Move down controls are the primary reorder interaction. They satisfy reordering without adding a large dependency or an inaccessible pointer-only path; the ordered pipeline should expose list semantics and clear position labels.

Queue drafts remain saved but do not execute. Activating a queue draft preserves its queue position. Cancelling or completing an entry may leave gaps internally, which is harmless because all selection orders by position then creation/id; reorder compacts mutable positions. New queue entries append after every existing nonterminal queue entry. Main risks are duplicate launch after restart, advancing before real completion, reorder races with scheduler claims, and cross-user/project mutation; generation tracking, conditional claims, transactional exact-set reorder, and existing project/user scoping address them. No user clarification is blocking because “queue” plus “reorder the pipeline” maps directly to an ordered durable queue within the existing project appointment domain.

# PLAN

1. Extend durable appointment contracts and SQLite persistence with a queue trigger, project/user queue positions, launched run generations, transactional reorder, ordered queue selection, and migration coverage.
2. Add project-scoped queue creation/reordering business rules and make the scheduler execute ordered queue entries serially while finalizing every launched appointment from its real durable run generation.
3. Expose queue creation and accessible pipeline reordering in the appointment modal, using server-authoritative ordering and focused frontend tests.

# GUIDELINES

- Follow ./AGENTS.md and ./.agents/skills/backend-module-standards/SKILL.md for all backend edits: keep routes thin, import other modules only through barrels, place multi-use contracts in ./server/shared/types.ts, and keep tests within the owning module.
- Interpret “queue” as an appointment trigger whose active entries form an ordered project/user pipeline; do not replace or silently alter exact, timer, or project-idle triggers.
- Persist queue ordering in SQLite. Use nullable integer `queue_position` only for queue-trigger appointments, order by it ascending with stable ID/creation tie-breakers, and append newly created queue entries after existing nonterminal entries in the same project/user scope.
- Persist the generation returned by detached run startup as `run_generation`; an appointment remains `running` until that exact durable generation reaches a terminal state.
- Never infer provider completion from `chatRunLifecycleService.start()` resolving. Reconcile `running` appointments from durable session-run state and generation identity.
- Treat a project as busy for queue dispatch when it has a live registry run or a durable desired/running/recoverable run state. A scheduler tick may launch at most one queue appointment per project, and never while another appointment in that project's pipeline is running.
- Running queue entries are pinned and excluded from reorder input. Reorder only the complete set of mutable nonterminal queue rows (`draft` and `scheduled`) in the authenticated project/user scope; reject duplicates, omissions, foreign IDs, non-queue rows, and stale status changes atomically.
- Use explicit Move up / Move down buttons as the accessible, mobile-safe primary reorder interaction; do not add a drag-and-drop package. Render ordered-list/position semantics and disable impossible moves.
- Refresh appointments from the server after reorder success. On failure, display the standard nested API error and restore/retain server-authoritative ordering.
- Preserve existing restart quarantine for active project-idle appointments, attachment revalidation, target-session deferral, active/draft controls, cancellation, literal slash prompts, and project/user ownership checks.
- Keep validation scoped to appointment database, routes/service, scheduler, modal/utilities, affected builds/typecheck, and touched-file lint. Do not modify VCS state.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Extend appointment shared contracts and SQLite persistence for durable queue ordering and launched-run generation tracking, including idempotent migration, project/user-scoped append allocation, ordered mutable queue listing, transactional exact-set reorder, running-appointment reconciliation queries, and focused database tests.
  **Files:**
  ./AGENTS.md - Read the repository backend guidance before changing server code.
  ./.agents/skills/backend-module-standards/SKILL.md - Follow backend module, shared-type, repository, export, and test rules.
  ./server/shared/types.ts - Add the `queue` trigger plus documented `queuePosition` and `runGeneration` appointment fields and mutation inputs.
  ./server/modules/database/schema.ts - Add fresh-install queue/generation columns and scheduler/order indexes.
  ./server/modules/database/migrations.ts - Add missing columns/indexes idempotently for existing appointment tables and initialize queue positions deterministically.
  ./server/modules/database/repositories/appointments.db.ts - Persist normalized queue/generation fields; append queue rows; expose ordered mutable queue rows, atomic exact-set reorder, running rows, generation assignment, and next queued selection support.
  ./server/modules/database/tests/appointments.db.test.ts - Cover fresh/upgrade schema, deterministic backfill, scoped append order, exact-set reorder validation primitives, running-row persistence, and reopen survival.
  ./server/modules/database/index.ts - Preserve/consume the appointments repository through the existing public barrel.
  **Acceptance criteria:** Fresh and upgraded databases support `queue` appointments with nullable `queue_position` and `run_generation`; legacy rows migrate idempotently; queue entries append deterministically within project/user scope; project/user reads return queue rows in pipeline order without breaking non-queue management; transactional reorder rewrites a complete mutable queue set contiguously and cannot affect another project/user or running/terminal rows; claimed rows can persist a launched generation and running rows can be listed for reconciliation after restart.
  **Validation:** Implement and run `TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/database/tests/appointments.db.test.ts`; run `npm run build:server`; run `npx eslint server/shared/types.ts server/modules/database/schema.ts server/modules/database/migrations.ts server/modules/database/repositories/appointments.db.ts server/modules/database/tests/appointments.db.test.ts`.
  **Summary:** Added queue/run-generation shared contracts; fresh and upgrade SQLite columns, indexes, trigger-table rebuild and deterministic backfill; and repository support for scoped append ordering, ordered reads, exact-set transactional reorder, next-queue selection, running reconciliation rows, and generation assignment. Expanded appointment database tests for schema/index upgrades, migration idempotence/backfill, scope isolation, reorder validation, running persistence, and reopen survival. The existing database barrel already exported `appointmentsDb`, so it required no code change.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Implement queue creation and reorder API rules, then upgrade the scheduler to launch one ordered queue entry per idle project and finalize all running appointments from their exact durable run generation rather than launch acceptance.
  **Files:**
  ./AGENTS.md - Read the repository backend guidance before changing server code.
  ./.agents/skills/backend-module-standards/SKILL.md - Follow feature-module, thin-route, barrel, shared-contract, and focused-test standards.
  ./server/shared/types.ts - Consume queue position and run generation contracts from item 1.
  ./server/modules/database/index.ts - Consume appointments, sessions, projects, and durable session-run state only through this barrel.
  ./server/modules/appointments/appointments.service.ts - Validate queue trigger creation and exact project/user mutable-pipeline reorder requests.
  ./server/modules/appointments/appointments.routes.ts - Add a thin authenticated project-scoped reorder endpoint that parses an ordered appointment ID array.
  ./server/modules/appointments/appointments.module.ts - Inject durable actionable run-state lookup and generation-aware lifecycle dependencies into the scheduler.
  ./server/modules/appointments/appointment-scheduler.service.ts - Reconcile recorded generations, preserve running status after launch, account for durable project activity, and dispatch at most one ordered queue row per idle project.
  ./server/modules/appointments/tests/appointments.routes.test.ts - Cover queue creation, successful reorder, duplicate/incomplete/foreign/non-queue/running rejection, and project/user isolation.
  ./server/modules/appointments/tests/appointment-scheduler.service.test.ts - Cover launch-generation persistence, true terminal reconciliation, restart recovery, project busy deferral, one-at-a-time order, cross-project parallel eligibility, and launch failures.
  ./server/modules/websocket/index.ts - Consume public lifecycle/registry capabilities and expose no unnecessary internals.
  ./server/modules/websocket/services/chat-run-lifecycle.service.ts - Existing detached start result supplies the generation that the appointment must record.
  ./server/modules/websocket/services/chat-run-registry.service.ts - Existing live registry contributes project busy state.
  ./server/modules/database/repositories/session-run-state.db.ts - Existing durable lifecycle records determine whether the recorded generation is active, completed, or failed.
  **Acceptance criteria:** Queue appointments can be created as active or draft and receive durable positions; authenticated users can reorder only the complete mutable pipeline for their selected project; invalid/stale reorder payloads fail without partial changes; due/idle behavior remains compatible; launch acceptance records generation and leaves the appointment running; later ticks complete/fail only when the same generation is terminal; restart does not duplicate a launched appointment; queue dispatch waits for live or durable project activity, respects saved order, launches no more than one row per project at a time, and can independently launch eligible rows for different projects.
  **Validation:** Implement and run `TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/appointments/tests/appointments.routes.test.ts server/modules/appointments/tests/appointment-scheduler.service.test.ts server/modules/database/tests/appointments.db.test.ts`; run `npm run build:server` and `npm run typecheck`; run `npx eslint server/modules/appointments server/shared/types.ts server/modules/database/repositories/appointments.db.ts server/modules/database/schema.ts server/modules/database/migrations.ts`.
  **Summary:** Added queue trigger creation and a thin authenticated `PUT /:projectId/queue` exact-set reorder API backed by project/user-scoped atomic repository validation. Upgraded scheduler wiring and behavior to persist detached launch generations, leave accepted launches running, reconcile exact durable generations to completion/failure, preserve restart safety, include live and durable project activity in busy checks, and dispatch ordered queue entries at most once per project while allowing independent projects. Expanded route and scheduler tests for queue creation/scope/invalid reorder, generation finalization, launch failures, durable busy deferral, ordering, and cross-project eligibility; all requested tests, builds, typecheck, and lint pass.

- [x] **ID:** 3 | **Batch:** 2
  **Task:** Add queue appointment creation and an accessible project pipeline reorder UI to the appointments modal, with typed API support, server-authoritative refresh/error behavior, English copy, and focused utility/static component tests.
  **Files:**
  ./src/components/chat/types/appointments.ts - Add the queue trigger plus returned queue position and run generation fields.
  ./src/utils/api.js - Add the authenticated project-scoped appointment reorder request.
  ./src/components/chat/view/subcomponents/PromptAppointmentModal.utils.ts - Add stable pipeline extraction/reorder helpers suitable for focused tests.
  ./src/components/chat/view/subcomponents/PromptAppointmentModal.tsx - Add the Queue trigger and ordered pipeline section with position labels and Move up/Move down controls that persist and refresh.
  ./src/components/chat/view/subcomponents/PromptAppointmentModal.test.tsx - Cover queue trigger payloads, ordering helpers, ordered-list semantics, accessible controls, and disabled boundary moves.
  ./src/components/chat/view/ChatInterface.tsx - Preserve existing appointment refresh ownership and consume successful reorder refresh behavior if needed.
  ./src/i18n/locales/en/chat.json - Add queue trigger, pipeline heading/help, position, move, saving, and reorder-failure copy.
  ./package.json - Use the repository's focused frontend test/build/typecheck/lint commands.
  **Acceptance criteria:** Users can choose Queue when creating an appointment; the modal renders mutable queue appointments in durable pipeline order separately and clearly from other appointment history/management; each movable entry has keyboard-accessible Move up and Move down controls, impossible boundary moves are disabled, and position is announced visually/accessibly; reorder sends the complete ordered mutable queue ID list, blocks duplicate submissions, refreshes from the server after success, and shows a useful error without losing server-authoritative order on failure; active/draft, review, postpone, cancel, exact/timer/project-idle, and mobile scrolling behavior remain intact.
  **Validation:** Implement and run `node --import tsx --test src/components/chat/view/subcomponents/PromptAppointmentModal.test.tsx`; run `npm run build:client` and `npm run typecheck`; run `npx eslint src/components/chat/types/appointments.ts src/utils/api.js src/components/chat/view/subcomponents/PromptAppointmentModal.utils.ts src/components/chat/view/subcomponents/PromptAppointmentModal.tsx src/components/chat/view/subcomponents/PromptAppointmentModal.test.tsx src/components/chat/view/ChatInterface.tsx`.
  **Summary:** Extended browser appointment contracts and API support for queue ordering; added stable mutable-pipeline extraction/reorder helpers; added Queue creation, a separate ordered pipeline with accessible position and boundary-aware move controls, duplicate-submit blocking, nested error handling, and awaited server refresh; preserved general appointment management/history and refresh ownership. Added English copy and focused payload/helper/static accessibility tests. Reconciled the API to item 2's final `PUT /api/appointments/:projectId/queue` route with `{ appointmentIds }`.

# CHANGELOG

- **ID 1:** Added durable queue ordering and run-generation appointment contracts, schema/migrations, repository operations, and focused passing database coverage.
- **ID 3:** Added typed queue creation and project queue reorder API support, stable pipeline helpers, accessible ordered pipeline controls with server-authoritative refresh/error behavior, English copy, and passing focused frontend validation.
- **ID 2:** Added project-scoped queue creation/reorder rules and generation-aware scheduler reconciliation, durable/live busy-project gating, ordered one-per-project queue dispatch, and passing focused backend validation.
