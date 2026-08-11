# Faster Session Switch Message Load

## CONTEXT

### Files

./src/stores/useSessionStore.ts - Owns application-scoped in-memory session slots, IndexedDB hydration, canonical history requests, cache persistence, and the session APIs available to selection surfaces.
./src/stores/sessionStore.helpers.ts - Contains pure ordering and cache/fetch acceptance policy suitable for focused performance and race tests.
./src/stores/sessionStore.helpers.test.ts - Covers cache hydration, revision reuse, and message-store helper behavior without mounting React.
./src/stores/sessionMessageCache.ts - Implements the durable IndexedDB transcript cache currently consulted asynchronously when a session fetch begins.
./src/stores/sessionMessageCache.test.ts - Exercises real IndexedDB hydration and user/session isolation through fake-indexeddb.
./src/stores/sessionStoreContext.ts - Exposes the application-scoped session store to chat and navigation components.
./src/components/chat/hooks/useChatSessionState.ts - Starts selected-session history loading, controls the visible loading state, and derives messages from the session store.
./src/components/chat/hooks/sessionMessageLoading.ts - Provides ownership tokens that prevent stale session-load completions from changing the active loading state.
./src/components/chat/hooks/sessionMessageLoading.test.ts - Covers load ownership across rapid session switches and is the focused home for loading-state policy tests.
./src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx - Handles the earliest pointer interaction on a visible session row and can initiate a safe transcript warm-up before selection rendering completes.
./src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx - Provides source-level sidebar interaction coverage and protects row-selection behavior.
./src/hooks/useProjectsState.ts - Performs the canonical project/session selection transition and navigation for sidebar, search, archived, and other session selection paths.
./src/hooks/useProjectsState.newSession.test.ts - Covers deterministic session-selection action ordering and can lock in selection-time warm-up behavior.
package.json - Defines focused frontend tests, frontend typechecking, zero-warning lint, and client build validation.

## ANALYSIS

The application already has both an application-scoped in-memory session store and an IndexedDB transcript cache, but ordinary selection still sets `isLoadingSessionMessages` true before cached rows become visible. Cache hydration is started only inside `fetchFromServer`, and the chat hook waits for the complete canonical network request before clearing its loading state. On a cold in-memory switch, even a session whose transcript is already stored locally therefore shows “Loading previous messages” until IndexedDB hydration and a React notification occur; on an uncached session it remains blocked by provider history I/O and full payload parsing.

The quickest safe improvement is to make selection proactively warm the target slot before the chat view commits, deduplicate hydration/fetch work, and treat locally available rows as immediately displayable while canonical validation continues. Pointer-down or pointer-enter on a sidebar row can buy an extra event/render turn, while the canonical selection callback covers keyboard, search, archived, deep-link-adjacent, and other non-row selection paths. The store should expose one idempotent warm-up operation rather than allowing components to assemble cache/network races themselves.

The warm-up should prioritize durable cache hydration and then conditionally validate canonical history in the background. Multiple hover, pointer-down, selection, and chat-effect calls for the same session must share in-flight work rather than opening duplicate IndexedDB transactions or issuing duplicate history requests. Existing fetch tickets, user-generation guards, cache hydration acceptance, ETag revision reuse, and server authority must remain intact. An in-memory slot that already has messages should render synchronously on selection. A cache hit should clear the blocking empty-state loader as soon as its rows arrive, even though the subtle “cached-validating” banner may continue until canonical completion. A truly uncached session still needs a network wait, but early pointer warm-up reduces perceived latency and concurrent request deduplication avoids wasted work.

Provider history adapters can be expensive, particularly file-backed histories, but introducing backend indexes or a new partial-history protocol would broaden the task and conflict with the current complete-transcript/cache contract. This pass should first remove the avoidable client-side delay and duplicate work around selection. Focused timing instrumentation/tests should assert immediate reuse for warmed in-memory sessions and one shared asynchronous load for repeated warm-up/selection calls; production build validation will catch React/context integration regressions.

The worktree contains many unrelated existing modifications, including in some target files. Implementation must preserve those edits, limit changes to the session-load optimization, and avoid VCS operations.

## PLAN

1. Add a deduplicated store-level session warm-up contract that hydrates IndexedDB promptly, reuses fresh in-memory data, and shares canonical fetches across anticipatory and committed selection calls.
2. Trigger warm-up at the earliest safe user intent and make the chat loading state stop blocking as soon as local rows are available while canonical validation continues.
3. Validate race safety, request deduplication, loading-state behavior, frontend integration, and the running client reload.

## GUIDELINES

- Preserve all unrelated worktree changes in touched files; inspect the current file content and patch narrowly rather than restoring or reformatting surrounding code.
- Keep the complete provider history response canonical and retain IndexedDB as an optimization; never skip strict history validation or suppress a required canonical refresh merely because cached rows exist.
- Put warm-up orchestration in ./src/stores/useSessionStore.ts so UI surfaces call one idempotent API instead of duplicating cache/network policy.
- Deduplicate concurrent work per authenticated namespace and session. Hover, pointer-down, canonical selection, and chat mounting must not produce duplicate full-history requests or conflicting cache hydration.
- Reuse a fresh complete in-memory slot synchronously. For stale or cache-only slots, render existing rows immediately and validate in the background using the existing revision/ETag and fetch-ticket protections.
- A cache hit should remove the blocking empty transcript loader as soon as messages are available. Canonical validation may continue through the existing cached-validating state/banner; an empty uncached session may continue showing the loader until the canonical request resolves.
- Warm-up events must not navigate, select, subscribe, change active-session ownership, or fetch session metadata. They may only prime transcript storage for the supplied stable session id.
- Do not restore automatic all-session caching or scan/prefetch every sidebar session. Warm only explicit near-term user intent such as pointer/focus interaction and committed selection.
- Preserve keyboard, touch, modifier-click, selection-mode, nested-session toggle, search result, archived-session, deep-link, websocket subscription, scroll restoration, and token-usage behavior.
- Avoid backend changes unless client validation proves they are required. No VCS operations are authorized.
- Use existing Node tests with `node --import tsx --test`, then run frontend typecheck, zero-warning targeted ESLint, and `npm run build:client`. Use the `cloudcli-reload` skill after source changes and verify service status.

## TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Implement an idempotent store-level warm-up/load contract for session transcripts. It must synchronously reuse fresh complete in-memory slots, start IndexedDB hydration immediately, share in-flight hydration and canonical fetch work for the same session, preserve user-generation/fetch-ticket/revision protections, and expose enough observable state for the chat hook to distinguish locally displayable rows from an empty blocking load.
  **Files:**
  ./src/stores/useSessionStore.ts - Add the deduplicated warm-up API and reconcile it with existing `hydrateFromCache`, `fetchFromServer`, freshness, notification, and return contracts.
  ./src/stores/sessionStore.helpers.ts - Add only pure warm-up/display policy helpers needed for deterministic tests.
  ./src/stores/sessionStore.helpers.test.ts - Cover fresh-slot reuse, cache-first display eligibility, canonical validation requirements, and repeated-call deduplication policy where extractable.
  ./src/stores/sessionMessageCache.ts - Preserve current IndexedDB behavior; change only if required to share a session hydration promise safely.
  ./src/stores/sessionMessageCache.test.ts - Add cache hydration concurrency or prompt-read coverage only if repository behavior changes.
  **Acceptance criteria:** Repeated warm-up/fetch requests for one session share one canonical network request and one effective cache hydration; a complete fresh in-memory session resolves without network or loading churn; cached rows can notify the active consumer before canonical completion; canonical responses remain authoritative; stale responses and previous-user hydration cannot apply; failures still fail open to existing network behavior; and existing store APIs remain compatible.
  **Validation:** Add focused tests for the extracted policy and any repository concurrency behavior; run `node --import tsx --test src/stores/sessionStore.helpers.test.ts src/stores/sessionMessageCache.test.ts`, `npm run typecheck:frontend`, and targeted zero-warning ESLint for touched store files.
  **Summary:** Added `warmSession`, per-slot shared hydration/canonical promises, fresh-complete synchronous reuse, and snapshot flags for displayable rows/canonical loading in `useSessionStore.ts`; added and tested pure warm-up policy in `sessionStore.helpers.ts`. Existing cache repository behavior was sufficient and unchanged. Validation passed: 23 focused tests, frontend typecheck, and zero-warning targeted ESLint.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Wire proactive warm-up into session selection and update chat loading behavior so a warmed in-memory transcript appears synchronously and an IndexedDB cache hit removes the blocking “Loading previous messages” state immediately while the shared canonical request continues. Start warm-up on safe sidebar pointer/focus intent and in the canonical selection callback so touch, keyboard, search, archived, and non-sidebar selection paths are covered without prefetching all sessions.
  **Files:**
  ./src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx - Prime the selected row's transcript on safe pointer/focus intent without altering navigation, selection mode, or nested-session behavior.
  ./src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx - Lock in warm-up event wiring and preserved row selection behavior.
  ./src/hooks/useProjectsState.ts - Invoke the store warm-up at committed session selection for every canonical selection path.
  ./src/hooks/useProjectsState.newSession.test.ts - Verify warm-up ordering and one navigation/selection transition without affecting New Session behavior.
  ./src/components/chat/hooks/useChatSessionState.ts - Consume the shared warm-up/load result, avoid setting a blocking loader when rows already exist, and clear it when cache hydration produces rows before canonical completion.
  ./src/components/chat/hooks/sessionMessageLoading.ts - Add only a pure loading-display transition helper if needed to keep hook logic race-safe and testable.
  ./src/components/chat/hooks/sessionMessageLoading.test.ts - Cover immediate warmed-session display, cache-hit unblocking, empty-session loading, and stale completion ownership.
  ./src/stores/sessionStoreContext.ts - Provide access to the application-scoped store where selection surfaces need it without introducing a second store instance.
  **Acceptance criteria:** Clicking a previously opened/cached session does not hold an empty “Loading previous messages” pane for the full network request; warmed in-memory rows render on the first committed session view; cached rows unblock the pane as soon as hydration notifies; canonical validation continues and updates rows safely; uncached empty histories retain an honest loader; hover/focus does not select or navigate; one user action does not duplicate history requests; and touch, keyboard, search, archived, nested, selection-mode, modifier-click, websocket, and scroll behavior remain correct.
  **Validation:** Add/update focused session-loading, selection-intent, and sidebar interaction tests; run `node --import tsx --test src/components/chat/hooks/sessionMessageLoading.test.ts src/hooks/useProjectsState.newSession.test.ts src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx src/stores/sessionStore.helpers.test.ts`, `npm run typecheck:frontend`, targeted zero-warning ESLint for all touched frontend files, and `npm run build:client`.
  **Summary:** Wired application-scoped `warmSession` into canonical selection and safe desktop pointer/focus intent, preserving selection/navigation ordering and selection-mode behavior. Chat now shares warm-up work, renders warmed rows immediately, and clears the blocking loader when cache rows notify while canonical validation continues; added focused loading and interaction coverage. Validation passed: 28 focused tests, frontend typecheck, targeted zero-warning ESLint, and production client build/bundle checks.

- [x] **ID:** 3 | **Batch:** 3
  **Task:** Reconcile the completed optimization with production frontend behavior, fix any task-related warnings or regressions, and reload the running CloudCLI frontend without replacing the container.
  **Files:**
  ./src/stores/useSessionStore.ts - Verify final warm-up deduplication, cache-first notification, and canonical authority in the integrated build.
  ./src/components/chat/hooks/useChatSessionState.ts - Verify final loading-state and rapid-switch behavior in the integrated build.
  ./src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx - Verify anticipatory events remain non-navigational and compatible with all row modes.
  ./src/hooks/useProjectsState.ts - Verify committed selection always primes the stable session id exactly once per shared in-flight operation.
  package.json - Use the existing validation commands without changing scripts unless a narrowly reusable test command is justified.
  **Acceptance criteria:** All focused tests, frontend typecheck, targeted zero-warning lint, and production client build pass; no new warnings are introduced; the emitted client contains the optimization; the running frontend reload completes successfully; and service status reports healthy after reload.
  **Validation:** Rerun all focused tests from Items 1 and 2, `npm run typecheck:frontend`, targeted ESLint with `--max-warnings 0`, and `npm run build:client`; then use the `cloudcli-reload` skill for a frontend reload and status check.
  **Summary:** Fixed canonical-loading snapshot observability by bumping the slot revision and notifying the active consumer when the shared canonical promise clears after success or failure. Validation passed: 41 combined focused tests, frontend typecheck, targeted ESLint with zero warnings, production client build/chunk/bundle checks, emitted optimization marker verification, frontend reload, and healthy running service status.

## CHANGELOG
- 2026-08-11 TODO 1: Implemented deduplicated transcript warm-up with cache-first observability and fresh canonical reuse; focused tests, frontend typecheck, and targeted zero-warning ESLint passed.
- 2026-08-11 TODO 2: Added anticipatory and committed-selection transcript warm-up plus cache-aware chat loader unblocking; 28 focused tests, frontend typecheck, targeted zero-warning ESLint, and client build passed.
- 2026-08-11 TODO 3: Made canonical in-flight clearing observable through snapshot revision/notification; 41 focused tests, frontend typecheck, zero-warning targeted lint, production build and emitted marker checks passed, then frontend reload completed with healthy running status.
