# CONTEXT

## FILES

./AGENTS.md - Repository guidance requires the backend module standards skill for every change under `server/`.
./.agents/skills/backend-module-standards/SKILL.md - Backend architecture rules require thin routes, deliberate module APIs, shared contracts where reused, and module-scoped tests.
./server/modules/appointments/appointments.routes.ts - The authenticated project/appointment HTTP surface needs a thin immediate-dispatch endpoint.
./server/modules/appointments/appointments.service.ts - Project/user ownership and queue-entry eligibility validation belong in this business layer.
./server/modules/appointments/appointments.module.ts - Service, scheduler, database, registry, and lifecycle dependencies are assembled here.
./server/modules/appointments/appointment-scheduler.service.ts - The existing claim, attachment validation, detached launch, generation assignment, project-busy checks, and failure transition should be reused for manual dispatch.
./server/modules/appointments/tests/appointments.routes.test.ts - Focused route/service coverage owns authorization, queue eligibility, state conflicts, and immediate-dispatch responses.
./server/modules/appointments/tests/appointment-scheduler.service.test.ts - Scheduler coverage owns forced launch, busy-project rejection, exact prompt forwarding, claim races, and launch failure behavior.
./server/modules/database/repositories/appointments.db.ts - Existing project/user reads, conditional claims, queue statuses, and generation persistence support manual launch without a schema change.
./server/modules/database/index.ts - Appointment persistence is consumed through this public database barrel.
./server/modules/websocket/index.ts - Run lifecycle and live registry activity are consumed through this public WebSocket barrel.
server/modules/websocket/services/chat-run-lifecycle.service.ts - Detached startup behavior is contextual; manual appointment dispatch should call it through the existing barrel-backed scheduler dependency.
./src/utils/api.js - The browser API client needs a project/appointment immediate-dispatch method.
./src/components/chat/view/subcomponents/PromptAppointmentModal.tsx - Each mutable pipeline card needs a Dispatch now button, per-entry pending state, refresh, and nested error handling.
./src/components/chat/view/subcomponents/PromptAppointmentModal.test.tsx - Focused static/component coverage should verify the accessible action and draft/active availability semantics.
./src/i18n/locales/en/chat.json - English dispatch action, pending status, success-neutral help, and failure copy belong in the appointments pipeline namespace.
src/components/chat/view/ChatInterface.tsx - Existing appointment refresh ownership is contextual and should remain unchanged.
./package.json - Focused Node tests, builds, typecheck, and ESLint commands define validation.

# ANALYSIS

The request is for an explicit button on a pipeline entry that starts that queued appointment immediately rather than waiting for the periodic idle-project queue selection. The action should target the clicked entry, not merely tick the scheduler, because users may dispatch an entry from any position and expect that specific prompt to run.

Immediate dispatch should bypass saved queue order and the entry's draft/active distinction for this one launch, but it must not violate project concurrency. Launching while another live or durable actionable run exists in the same project can corrupt session flow and contradict the queue's one-at-a-time model, so the endpoint should return a conflict and leave the appointment unchanged. The target must belong to the authenticated project/user, have trigger type `queue`, and be mutable (`draft` or `scheduled`). Running or terminal rows cannot be launched again. A draft can be atomically promoted to scheduled immediately before the normal claim; if the claim loses a race, return conflict without duplicate execution.

The scheduler already owns the security-sensitive execution path: target-session activity checks, atomic claim, uploaded attachment revalidation, exact prompt/options forwarding, detached start, run-generation assignment, and launch-failure transition. Expose one focused `dispatchNow` method from the scheduler rather than duplicating this orchestration in routes or the appointment service. That method should resolve the target project path, compute live/durable busy state, optionally activate the draft through a conditional scoped update/service preparation, and report a small result or throw a typed conflict through the service. The service remains responsible for user/project scope and row eligibility before calling the scheduler, while the route only parses IDs and serializes the result.

The UI should place a clearly labeled `Dispatch now` button beside Activate/Make draft and Cancel on each mutable pipeline card. It should work for both active and draft entries, disable all dispatch buttons while one request is pending (or at minimum the selected one), show `Dispatching…` on the selected entry, refresh server-authoritative appointments after acceptance, and show the backend's nested error message when the project is busy or the row changed. No confirmation is necessary because the user explicitly requested immediate execution and the action is reversible only through normal run interruption after launch.

# PLAN

1. Add a project/user-scoped immediate queue dispatch operation that reuses scheduler launch orchestration and rejects busy, stale, non-queue, running, terminal, or foreign entries without duplicate execution.
2. Add the pipeline Dispatch now button with pending/error/refresh behavior and focused accessibility coverage.

# GUIDELINES

- Follow ./AGENTS.md and ./.agents/skills/backend-module-standards/SKILL.md for backend edits: routes parse only, service owns scope/eligibility, scheduler owns execution orchestration, and cross-module dependencies use barrels.
- Dispatch the clicked queue entry even when it is not first in queue order; this is an explicit manual override of ordering for one entry.
- Permit immediate dispatch from both `draft` and `scheduled` queue states; the operation should atomically make a draft claimable as part of the launch path.
- Never dispatch a `running`, `completed`, `failed`, `cancelled`, `needs_review`, or non-queue appointment.
- Preserve one-run-at-a-time project safety: reject immediate dispatch while the project has a live registry run or durable desired/running/recoverable state, including another queue entry.
- Reuse attachment filtering, prompt/options forwarding, atomic claim, generation assignment, and failure transition from ./server/modules/appointments/appointment-scheduler.service.ts; do not create a parallel provider launch implementation.
- Return conflict errors for stale eligibility, busy project/session, or a lost claim; leave the row unlaunched when rejected.
- Keep queue positions unchanged; the launched row leaves the mutable pipeline by becoming `running`, and remaining rows retain their durable relative order.
- In the UI, use a text button with an accessible label, selected-entry pending text, duplicate-submit prevention, nested backend error extraction, and awaited server refresh.
- Add only English copy, consistent with the existing queue feature scope; do not perform unrelated localization work.
- Keep validation focused to appointments backend, modal/API frontend, builds/typecheck, and touched-file lint. Do not modify VCS state.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Implement authenticated immediate dispatch for one mutable queue appointment by adding service/route orchestration and a scheduler manual-dispatch method that safely reuses the existing claim-and-launch path.
  **Files:**
  ./AGENTS.md - Read repository backend guidance before changing server code.
  ./.agents/skills/backend-module-standards/SKILL.md - Follow backend feature-module, route, export, shared-contract, and focused-test rules.
  ./server/modules/appointments/appointments.routes.ts - Add a thin project/appointment-scoped immediate-dispatch endpoint.
  ./server/modules/appointments/appointments.service.ts - Validate project/user ownership, queue trigger, mutable status, and map scheduler conflicts to typed API errors.
  ./server/modules/appointments/appointments.module.ts - Wire the service to the scheduler/manual-dispatch dependency without introducing circular initialization.
  ./server/modules/appointments/appointment-scheduler.service.ts - Expose manual dispatch that checks live/durable project activity, activates drafts safely, atomically claims, filters attachments, launches detached, assigns generation, and reports conflicts/failures.
  ./server/modules/appointments/tests/appointments.routes.test.ts - Cover successful active and draft dispatch requests plus missing/foreign/non-queue/running/terminal/busy/stale rejection.
  ./server/modules/appointments/tests/appointment-scheduler.service.test.ts - Cover dispatching a non-head entry, busy project/session rejection, draft activation, exact payload forwarding, claim races, generation assignment, and launch failures.
  ./server/modules/database/repositories/appointments.db.ts - Reuse existing scoped update/claim/generation operations; add only the smallest conditional primitive needed for race-safe draft dispatch.
  ./server/modules/database/index.ts - Consume appointment persistence through the existing public barrel.
  ./server/modules/websocket/index.ts - Consume lifecycle/registry dependencies through the existing public barrel.
  server/modules/websocket/services/chat-run-lifecycle.service.ts - Contextual detached launch behavior; do not modify unless required by a failing regression.
  ./package.json - Use repository validation commands.
  **Acceptance criteria:** `POST /api/appointments/:projectId/:appointmentId/dispatch` immediately launches the authenticated user's selected `draft` or `scheduled` queue entry even when it is not pipeline head; prompt/options/attachments are forwarded through the existing validated launch path; the row becomes `running` with its generation persisted after acceptance; draft dispatch becomes claimable atomically; project live/durable activity, target-session activity, stale/lost claims, foreign ownership, non-queue types, and non-mutable statuses return a useful 4xx conflict/error without duplicate launch; queue positions and unrelated rows are unchanged; normal scheduler behavior remains compatible.
  **Validation:** Implement and run `TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/appointments/tests/appointments.routes.test.ts server/modules/appointments/tests/appointment-scheduler.service.test.ts server/modules/database/tests/appointments.db.test.ts`; run `npm run build:server` and `npm run typecheck:backend`; run `npx eslint server/modules/appointments server/modules/database/repositories/appointments.db.ts`.
  **Summary:** Added the authenticated dispatch route and service validation/error mapping, scheduler-backed manual launch with project/session concurrency checks and existing attachment/payload/claim/generation/failure orchestration, and a scoped conditional draft-activation repository primitive. Wired dependencies through existing database/WebSocket barrels and expanded focused route, scheduler, and repository tests; all specified tests, server build, backend typecheck, and ESLint pass.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Add a Dispatch now action to every mutable pipeline card, with typed API invocation, selected-entry loading state, duplicate prevention, server refresh, nested error display, English copy, and focused accessibility/static tests.
  **Files:**
  ./src/utils/api.js - Add the authenticated project/appointment immediate-dispatch request.
  ./src/components/chat/view/subcomponents/PromptAppointmentModal.tsx - Render and handle Dispatch now for draft and active queue entries with per-entry pending state and refresh/error behavior.
  ./src/components/chat/view/subcomponents/PromptAppointmentModal.test.tsx - Verify accessible Dispatch now rendering for mutable entries, active/draft availability, and pending-state markup where testable.
  ./src/i18n/locales/en/chat.json - Add Dispatch now, Dispatching, and dispatch-failure pipeline copy.
  src/components/chat/view/ChatInterface.tsx - Preserve existing appointment refresh ownership; no change expected.
  ./package.json - Use repository frontend validation commands.
  **Acceptance criteria:** Every draft or scheduled pipeline entry displays an accessible `Dispatch now` button; clicking it calls the new endpoint for that exact appointment; the selected action shows a pending state and duplicate dispatch/reorder/management submissions are prevented while it is in flight; success awaits and applies server-authoritative appointment refresh; failure displays the nested backend message or localized fallback while retaining pipeline order; Move, Activate/Make draft, Cancel, mobile layout, and ordered-list semantics remain usable when no dispatch is pending.
  **Validation:** Implement and run `node --import tsx --test src/components/chat/view/subcomponents/PromptAppointmentModal.test.tsx`; run `npm run build:client` and `npm run typecheck:frontend`; run `npx eslint src/utils/api.js src/components/chat/view/subcomponents/PromptAppointmentModal.tsx src/components/chat/view/subcomponents/PromptAppointmentModal.test.tsx`.
  **Summary:** Added the encoded authenticated dispatch API request, per-appointment dispatch handling and pending text in the pipeline UI, disabled duplicate/reorder/Activate/Make draft/Cancel controls during dispatch, awaited authoritative refresh, and reused nested backend error extraction with localized fallback. Added English action/failure copy and focused static coverage for draft/scheduled accessible actions while preserving ordered-list and responsive action layout; all specified frontend tests, build, typecheck, and ESLint pass.

# CHANGELOG

- **ID 1:** Implemented immediate authenticated dispatch for mutable queue appointments, including race-safe draft activation, scheduler launch reuse, typed conflicts, dependency wiring, and focused passing coverage.
- **ID 2:** Added immediate dispatch controls for every mutable pipeline entry with exact endpoint targeting, selected pending state, conflict-control disabling, awaited refresh, nested errors, English copy, and passing focused frontend validation.
