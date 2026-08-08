# CONTEXT

## FILES

./AGENTS.md - Repository guidance requires the backend module standards skill for every change under `server/`.
./.agents/skills/backend-module-standards/SKILL.md - Backend architecture rules require module barrels, documented exports, thin orchestration boundaries, and focused tests.
./server/modules/database/migrations.ts - The provider-session mapping migration currently rewrites every NULL mapping on every startup, including deliberately pending app-created sessions.
./server/modules/database/repositories/sessions.db.ts - App-created sessions deliberately store a NULL provider-native id until the first provider run announces one.
./server/modules/database/tests/sessions-provider-mapping.test.ts - Session gateway persistence tests cover pending app rows, native-id assignment, duplicate merging, and legacy provider-keyed rows.
./server/modules/providers/services/sessions.service.ts - Provider runtimes resolve a stored provider-native id and must receive NULL for a never-started app-created session so the provider starts a new conversation.
./server/modules/providers/list/opencode/opencode-runtime.provider.ts - OpenCode adds `--session` whenever resolution returns a provider id; passing the app UUID here causes `Session not found` before the queued prompt is accepted.
./server/modules/providers/tests/opencode-runtime.test.ts - Focused runtime coverage can assert that pending app sessions launch without `--session` and still include the queued prompt.
./server/modules/appointments/appointment-scheduler.service.ts - Queue dispatch already forwards the persisted prompt to detached run startup and is contextual to the observed failure.
./server/modules/appointments/tests/appointment-scheduler.service.test.ts - Existing scheduler tests prove queue ordering and command forwarding at the scheduler boundary.
server/modules/websocket/services/chat-run-lifecycle.service.ts - Detached appointment starts pass the command unchanged to the provider runtime and are contextual to the fault path.
package.json - Focused Node tests, backend build, typecheck, and ESLint commands define validation.

# ANALYSIS

The queue scheduler is dispatching correctly and the persisted appointment prompt is non-empty. Production SQLite evidence shows the launched OpenCode appointment fails with `Session not found`, while its app-created session row has `provider_session_id` equal to the app UUID. That value should have remained NULL until OpenCode created a native session and announced its id.

The root cause is `addProviderSessionIdMapping`: it runs during every database initialization and executes `UPDATE sessions SET provider_session_id = session_id WHERE provider_session_id IS NULL`. This statement was intended as a one-time legacy backfill, but it also corrupts every deliberately pending session created through `createAppSession` after the mapping column already exists. On the next server restart, OpenCode resolution returns the app UUID, the runtime emits `opencode run ... --session <app UUID> <prompt>`, and OpenCode rejects the nonexistent native session before receiving the task. The UI then has no provider transcript or user turn to display.

The migration must distinguish the one-time schema upgrade from normal startup. Backfill existing NULL rows only when the `provider_session_id` column is first added; when the column already exists, preserve NULL as the valid pending-app-session state. This keeps legacy provider-keyed rows resolvable while allowing new or queued sessions to start fresh after any restart. Existing already-corrupted pending rows cannot be identified solely by NULL because they are no longer NULL, but app-created UUID rows with no provider transcript (`jsonl_path` NULL) and self-mapped provider id are strong repair candidates. A narrowly scoped repair migration should clear only self-mapped UUID-style rows that have no transcript path; true legacy native rows may also be UUIDs, so destructive automatic repair is risky. Prefer fixing future behavior and add a safe startup repair only if tests can encode an unambiguous app-created marker available in current schema. For the observed queued rows, resetting the mapping through a repository-aware repair may be necessary so the fix works without asking users to recreate tasks.

The implementation should add regression tests that simulate: app session creation, database close/reopen/initialize, mapping remaining NULL, provider resolution returning NULL, and OpenCode invocation omitting `--session` while retaining the exact prompt. It should preserve the legacy-upgrade case where a pre-column provider-keyed row is backfilled to itself.

# PLAN

1. Make provider-session-id migration genuinely one-time and repair only unambiguous pending app-created mappings if the current schema provides a safe discriminator.
2. Add database and OpenCode runtime regression coverage for restart-safe pending sessions and exact queued prompt delivery.
3. Safely repair already-corrupted OpenCode appointment sessions so existing queued tasks can be retried without recreation.

# GUIDELINES

- Follow ./AGENTS.md and ./.agents/skills/backend-module-standards/SKILL.md for all backend edits.
- Preserve NULL `provider_session_id` for app-created sessions until a provider runtime or synchronizer assigns the real native id.
- Backfill `provider_session_id = session_id` only during the schema transition that first adds the mapping column; do not repeat that update on ordinary startup.
- Do not broadly clear self-mapped rows without an unambiguous app-created discriminator; legacy provider-keyed sessions must remain resumable.
- An OpenCode session is safe to repair when it is referenced by an appointment, its app id is UUID-shaped, and `provider_session_id` self-maps to that UUID; appointment creation always uses the app session gateway, while current native OpenCode ids are not app UUIDs.
- OpenCode must omit `--session` for a pending app session and append the exact non-empty queued prompt as its run argument.
- Keep the scheduler and frontend unchanged unless a failing regression proves a separate fault; current evidence shows the prompt reaches lifecycle startup and is rejected only by invalid native-session resume.
- Keep validation focused on session mapping, OpenCode runtime invocation, appointment scheduler regression, backend build/typecheck, and touched-file lint.
- Do not modify VCS state.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Fix restart corruption of pending app-created provider session mappings and add end-to-end boundary regression coverage proving an OpenCode appointment prompt launches as a fresh native session after database reinitialization.
  **Files:**
  ./AGENTS.md - Read repository backend guidance before changing server code.
  ./.agents/skills/backend-module-standards/SKILL.md - Follow backend module, export, documentation, and focused-test standards.
  ./server/modules/database/migrations.ts - Restrict legacy provider-session-id backfill to the first column-add migration and preserve pending NULL mappings on later startups.
  ./server/modules/database/repositories/sessions.db.ts - Preserve the documented pending app-session invariant and add only narrowly justified repository support if safe repair is possible.
  ./server/modules/database/tests/sessions-provider-mapping.test.ts - Add close/reopen initialization regression coverage plus a legacy pre-column backfill case.
  ./server/modules/providers/services/sessions.service.ts - Verify pending app sessions resolve to NULL while mapped/legacy sessions resolve to provider-native ids.
  ./server/modules/providers/list/opencode/opencode-runtime.provider.ts - Consume NULL as a fresh-session launch and keep the queued prompt as the final run argument; modify only if regression exposes a runtime defect.
  ./server/modules/providers/tests/opencode-runtime.test.ts - Add a pending app-session runtime test asserting no `--session` flag and exact prompt delivery.
  ./server/modules/appointments/appointment-scheduler.service.ts - Confirm the scheduler still forwards the exact stored prompt; avoid changes unless necessary.
  ./server/modules/appointments/tests/appointment-scheduler.service.test.ts - Strengthen command-forwarding coverage if needed to pin the appointment boundary.
  server/modules/websocket/services/chat-run-lifecycle.service.ts - Contextual lifecycle boundary; do not modify unless required by a failing regression.
  ./package.json - Use repository test, build, typecheck, and lint commands.
  **Acceptance criteria:** An app-created session with no provider-native id remains NULL after database close/reopen and repeated `initializeDatabase()` calls; legacy databases that first gain the mapping column still backfill provider-keyed rows to themselves; resolving a pending app session returns NULL; an OpenCode run for that pending app session omits `--session` and includes the exact queued prompt; scheduler dispatch still forwards the exact prompt; focused regressions fail on the old behavior and pass after the fix; no legacy mapped session behavior regresses.
  **Validation:** Implement and run `TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/database/tests/sessions-provider-mapping.test.ts server/modules/providers/tests/opencode-runtime.test.ts server/modules/appointments/tests/appointment-scheduler.service.test.ts`; run `npm run build:server` and `npm run typecheck:backend`; run `npx eslint server/modules/database/migrations.ts server/modules/database/repositories/sessions.db.ts server/modules/database/tests/sessions-provider-mapping.test.ts server/modules/providers/services/sessions.service.ts server/modules/providers/list/opencode/opencode-runtime.provider.ts server/modules/providers/tests/opencode-runtime.test.ts server/modules/appointments/appointment-scheduler.service.ts server/modules/appointments/tests/appointment-scheduler.service.test.ts`.
  **Summary:** Updated `server/modules/database/migrations.ts` so provider-session backfill occurs only when the mapping column is first introduced, including legacy table rebuilds, while later initialization preserves pending NULL mappings. Added restart/repeated-init and pre-column legacy regressions in `sessions-provider-mapping.test.ts`, a pending OpenCode invocation regression proving no `--session` and exact final prompt delivery, and an appointment scheduler exact-command boundary assertion. No repository, provider service/runtime, or scheduler implementation changes were needed because their existing NULL-resolution and prompt-forwarding behavior was correct. All focused tests, server build, backend typecheck, and requested ESLint checks pass.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Add an idempotent, narrowly scoped migration repair for already-corrupted app-created OpenCode sessions referenced by appointments, clearing only UUID-shaped self-mapped provider ids so existing queued tasks launch fresh on retry.
  **Files:**
  ./AGENTS.md - Read repository backend guidance before changing server code.
  ./.agents/skills/backend-module-standards/SKILL.md - Follow backend module, migration, documentation, and focused-test standards.
  ./server/modules/database/migrations.ts - Add the safe appointment-session repair after appointment schema availability without altering legitimate legacy mappings.
  ./server/modules/database/tests/sessions-provider-mapping.test.ts - Cover repair of corrupted appointment-linked OpenCode app UUIDs, idempotence, and preservation of non-appointment, non-OpenCode, mapped-native, and non-UUID rows.
  ./server/modules/database/tests/appointments.db.test.ts - Contextual appointment schema/setup coverage; update only if the repair is more naturally validated here.
  ./server/modules/database/schema.ts - Appointment/session table contracts used by the repair query; do not modify unless required.
  ./package.json - Use repository test, build, typecheck, and lint commands.
  **Acceptance criteria:** On initialization, an OpenCode session referenced by an appointment with UUID-shaped `session_id` and `provider_session_id = session_id` is reset to a NULL provider mapping; the repair is idempotent; legitimate provider-native/self-mapped sessions not satisfying all predicates remain unchanged; other providers remain unchanged; existing appointment rows and statuses are not mutated; after repair, normal provider resolution treats the session as fresh and retrying the queue can deliver its prompt.
  **Validation:** Implement and run `TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/database/tests/sessions-provider-mapping.test.ts server/modules/database/tests/appointments.db.test.ts server/modules/providers/tests/opencode-runtime.test.ts server/modules/appointments/tests/appointment-scheduler.service.test.ts`; run `npm run build:server` and `npm run typecheck:backend`; run `npx eslint server/modules/database/migrations.ts server/modules/database/tests/sessions-provider-mapping.test.ts server/modules/database/tests/appointments.db.test.ts`.
  **Summary:** Added an initialization repair in `server/modules/database/migrations.ts` after appointment schema migration that clears only self-mapped OpenCode session ids matching the canonical 36-character hexadecimal UUID shape and referenced by an appointment. Added focused coverage in `sessions-provider-mapping.test.ts` proving repair and repeat-initialization idempotence while preserving appointment payload/status fields, mapped-native OpenCode rows, other providers, non-appointment UUID rows, and non-UUID legacy rows. Existing provider resolution/runtime and scheduler regressions continue to prove repaired NULL mappings launch fresh with the exact queued prompt. All requested focused tests, server build, backend typecheck, and ESLint checks pass; no appointment or schema test changes were needed.

# CHANGELOG

- **ID 1:** Made provider-session mapping backfill one-time, preserved pending NULL mappings across restarts, and added database, OpenCode prompt/argument, and scheduler forwarding regressions; focused tests, build, typecheck, and lint pass.
- **ID 2:** Added an idempotent post-appointment-schema repair for UUID-shaped self-mapped OpenCode appointment sessions and focused preservation coverage; requested tests, build, typecheck, and lint pass.
