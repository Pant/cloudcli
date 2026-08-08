# CONTEXT

## FILES

./src/hooks/useProjectsState.ts - Owns selected project/session state and route navigation; its project-select handler clears the current session and navigates home while its session-select handler separately navigates to the target session.
./src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx - Handles sidebar session-row clicks and currently invokes project selection before session selection, creating two competing state/navigation transitions for one click.
./src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx - Renders New Session controls; the mobile control currently invokes project selection before the already-atomic New Session callback.
./src/components/sidebar/hooks/useSidebarController.ts - Adapts session-row clicks into app-level session selection and tags each session with its owning project id.
./src/components/sidebar/types/types.ts - Defines the app-level sidebar project/session callback contracts that constrain an atomic selection fix.
./src/components/sidebar/view/Sidebar.tsx - Threads app callbacks through the sidebar controller and project/session components.
./src/hooks/useProjectsState.newSession.test.ts - Contains the existing focused regression for the atomic New Session intent transition.
./src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx - Provides the existing Node/static-render test style for sidebar session controls and rows.
./src/appRoutes.test.tsx - Protects the persistent shared root/session route identity that must remain intact.
./src/components/chat/hooks/sessionSelection.test.ts - Protects chat identity behavior during transient and rapid session selection changes.
./package.json - Defines Node test, frontend typecheck, scoped ESLint, and client build commands.
dist/index.html - Generated client entrypoint used by the running container; it must only change through the client build.
plans/fix-new-session-single-click.md - Records earlier fixes for route lifetime, root-selection races, and stale loading state, all of which must remain preserved.

# ANALYSIS

The two reported failures share the same sidebar interaction path. A session-row click calls `onProjectSelect(project)` and then `onSessionSelect(session, projectId)`. The first callback is not a passive context update: `useProjectsState.handleProjectSelect` clears `selectedSession` and navigates to `/`. The second callback then selects the session and navigates to `/session/:id`. One physical click therefore emits two opposing route/selection intents. React state batching does not make this safe because router updates and route-synchronization effects can observe the intermediate home transition; the existing root-authoritative effect intentionally clears any selected session when `/` is observed. This can leave the present session selected or make switching appear inert.

The mobile New Session control repeats the same anti-pattern: it calls project selection first, even though `handleNewSession` already atomically selects the project, clears the session, switches to chat, increments the reset trigger, navigates home, and closes the mobile sidebar. That duplicate pre-transition can reintroduce the races addressed in the earlier New Session fixes.

The minimal durable fix is to make each user action produce exactly one app-level intent. Session selection should carry the owning project context into `useProjectsState` and atomically set both project and session before navigating once to the target URL. Sidebar session rows should stop invoking the destructive project-select callback separately. New Session controls should invoke only the existing atomic New Session callback on both desktop and mobile. Existing project-row selection behavior remains unchanged.

Regression coverage should verify callback composition, not only route matching or helper state mutation: a session-row action must issue one session-selection intent without a project-selection/home-navigation precursor, and both New Session controls must issue one New Session intent. The existing route, New Session intent, chat identity, typecheck, lint, and build checks should remain green. The running container serves the bind-mounted `dist` build and currently references `/assets/index-CBZQYb5p.js`; a successful build should regenerate the entry asset without manual edits.

Live authenticated reproduction after item 1 shows the route and selected row now change correctly, but `useChatSessionState` repeatedly re-fetches the selected transcript instead of committing one load. `selectedIdentity` and `committedIdentity` are newly allocated objects on every render. The main session-loading effect, initial token-usage effect, and related callbacks depend on the `committedIdentity` object, so state updates caused by one fetch trigger a render, the object dependency changes by reference, and another fetch begins. In the running UI one unchanged session issued 17 message requests in 12 seconds; switching rows issued the new URL request but left the pane in `Loading session messages...` or otherwise prevented a stable transcript commit.

The corrective fix must give session identity stable referential semantics across renders when the selected session/project/draft inputs have not changed. The preferred boundary is inside `useChatSessionState`: memoize selected and committed identities from primitive ids and the stable draft state, or make all effects depend only on primitive identity keys while retaining exact stale-result guards. A real session-id change must still synchronously point rendering at the new store slot and start exactly one authoritative load; rerenders caused by loading, pagination, token usage, viewport, or store notifications must not restart that load. Focused regression coverage should lock down stable identity/input behavior and request ownership, and authenticated browser validation should assert that session A to session B changes both the URL and visible transcript with a bounded request count.

# PLAN

Replace compound sidebar actions with one atomic app-state transition per click: pass project ownership through session selection, update project/session together before a single target-route navigation, and remove redundant project selection from session-row and mobile New Session handlers. Add focused interaction-composition regressions and run the existing session/navigation checks plus frontend static validation and build.

# GUIDELINES

- Keep the change frontend-only; no `server/` files are in scope.
- Preserve the shared persistent route hierarchy in ./src/appRoutes.tsx and the root-authoritative selection cleanup in ./src/hooks/useProjectsState.ts.
- Treat ./src/hooks/useProjectsState.ts as the authority for atomic project/session/New Session transitions; sidebar view components should emit one semantic intent per user action.
- Preserve modified-click behavior on desktop session anchors so Ctrl/Cmd/Shift/Alt clicks and native link actions can still open `/session/:id` normally.
- Preserve branch disclosure behavior: clicking a row may still toggle a branch according to `sessionRowPolicy`, but it must not emit a separate project-select intent.
- Preserve project-row selection and archived-session behavior unless a minimal callback-signature adaptation is required.
- Follow the repository's Node `node:test` style; keep tests focused and avoid adding a new test framework.
- Do not edit dist/index.html or built assets manually; regenerate them with `npm run build:client`.
- Avoid unrelated refactors and preserve existing working-tree changes.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Make sidebar New Session and session-row clicks atomic by removing redundant project-selection calls, carrying the owning project into app-level session selection, updating project/session state together before one navigation, and adding focused regressions for the callback composition and state transition.
  **Files:**
  ./src/hooks/useProjectsState.ts - Implement or extract the atomic session-selection transition while preserving New Session, root-route synchronization, mobile sidebar behavior, attention clearing, and active-tab semantics.
  ./src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx - Change row clicks to emit only the session-selection intent while retaining anchor modified-click and hierarchy-toggle behavior.
  ./src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx - Remove the mobile New Session pre-call to project selection so both responsive controls invoke only the atomic New Session callback.
  ./src/components/sidebar/hooks/useSidebarController.ts - Carry the owning project context from a sidebar row into the app-level session-selection callback without a separate project-select action.
  ./src/components/sidebar/types/types.ts - Update callback types if needed for atomic project-plus-session selection.
  ./src/components/sidebar/view/Sidebar.tsx - Thread any narrowed callback-contract changes through the sidebar without changing unrelated behavior.
  ./src/hooks/useProjectsState.newSession.test.ts - Retain the existing New Session regression and extend focused helper-level coverage if the atomic session transition is extracted here or into an adjacent test.
  ./src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx - Add focused sidebar markup/interaction-contract coverage where practical for single-intent New Session and session-row actions.
  ./src/appRoutes.test.tsx - Run the persistent route regression unchanged.
  ./src/components/chat/hooks/sessionSelection.test.ts - Run rapid/transient chat identity regressions unchanged.
  package.json - Use the repository's focused Node test, frontend typecheck, ESLint, and client build commands.
  dist/index.html - Confirm the generated entrypoint references the fresh build; do not edit it manually.
  plans/fix-new-session-single-click.md - Read the prior race fixes and preserve their behavior; do not edit this historical plan.
  **Acceptance criteria:** One New Session click from an existing session immediately leaves the current session and shows a clean draft at `/`; one sidebar session-row click selects the clicked session and updates the URL to `/session/:id`; switching repeatedly between sidebar sessions never remains on the prior session; each action performs only one semantic app navigation/selection transition; desktop modified-click link behavior, mobile sidebar closure, project-row selection, nested branch disclosure, and previous New Session/loading fixes remain intact.
  **Validation:** Add and run focused Node tests proving an atomic project-plus-session transition and proving sidebar controls no longer compose project selection with New Session/session selection; run `node --import tsx --test src/hooks/useProjectsState.newSession.test.ts src/components/sidebar/view/subcomponents/SidebarProjectSessions.test.tsx src/appRoutes.test.tsx src/components/chat/hooks/sessionSelection.test.ts`; run `npx eslint` on every changed frontend/test file; run `npm run typecheck:frontend`; run `npm run build:client`; confirm `dist/index.html` references the newly generated entry asset; if authenticated browser state is available without disruptive setup, exercise existing session -> New Session and session A -> session B in the running UI.
  **Summary:** Added `applySessionSelectionIntent` in `src/hooks/useProjectsState.ts` and changed sidebar session selection to pass the owning `Project`, atomically select project/session, preserve attention/tab/mobile behavior, and navigate once. Removed redundant project selection from session rows, mobile New Session, archived/search session paths where project context exists, and threaded callback types through sidebar components. Extended focused Node regressions for transition ordering/single navigation and source-level control composition. Focused tests (15), scoped ESLint, frontend typecheck, and client build all pass; `dist/index.html` references fresh `index-DHYGL1VH.js`. Browser interaction was not attempted because no authenticated browser state was available without setup.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Stabilize chat session identity across rerenders so selecting a sidebar session starts one owned transcript load, commits the clicked session's store slot, and does not restart message/token requests on state updates; add regressions and verify the complete switch in the authenticated running UI.
  **Files:**
  ./src/components/chat/hooks/useChatSessionState.ts - Stabilize selected/committed identity dependencies and preserve exact stale-request, draft-adoption, loading, pagination, token, and viewport behavior.
  ./src/components/chat/hooks/sessionSelection.ts - Extend the identity helper contract only if needed to expose primitive/stable selection inputs without weakening exact identity comparisons.
  ./src/components/chat/hooks/sessionSelection.test.ts - Add focused regression coverage for unchanged selection inputs versus true A-to-B identity changes.
  ./src/components/chat/hooks/sessionMessageLoading.ts - Preserve generation ownership so stale A completion cannot affect B; adjust only if stable identity reveals a concrete ownership gap.
  ./src/components/chat/hooks/sessionMessageLoading.test.ts - Retain and extend stale-completion/request-ownership coverage if needed.
  ./src/stores/useSessionStore.ts - Read to preserve active-slot notification and fetch semantics; modify only if a minimal in-flight coalescing safeguard is required in addition to fixing the effect dependency.
  ./src/components/chat/view/ChatInterface.tsx - Read the hook integration and selected-session props; avoid remount workarounds unless stable identity cannot solve the reproduced loop.
  ./src/components/chat/view/subcomponents/ChatMessagesPane.tsx - Observable contract: loading must settle and the clicked transcript must replace the previous one.
  ./src/hooks/useProjectsState.ts - Preserve item 1's atomic session/project selection and single navigation behavior.
  ./src/hooks/useProjectsState.newSession.test.ts - Run the atomic sidebar transition regression unchanged.
  ./src/appRoutes.test.tsx - Run the persistent route regression unchanged.
  package.json - Use focused Node tests, scoped ESLint, frontend typecheck, and client build tooling.
  dist/index.html - Confirm the generated entrypoint references the fresh build; do not edit manually.
  **Acceptance criteria:** Clicking session B while viewing session A changes the URL and visible transcript to B; the old transcript is never retained as B's committed view; an unchanged selected session does not restart its message or token-usage fetch because of loading/store/viewport rerenders; a true A-to-B change starts B's load and stale A completion cannot alter B; loading settles normally for empty and non-empty histories; New Session, rapid A-B-A switching, active streaming, cached history, and item 1's atomic navigation remain intact.
  **Validation:** Add and run focused Node tests for stable unchanged identity, true identity changes, and stale loading ownership; run `node --import tsx --test src/components/chat/hooks/sessionSelection.test.ts src/components/chat/hooks/sessionMessageLoading.test.ts src/hooks/useProjectsState.newSession.test.ts src/appRoutes.test.tsx`; run scoped `npx eslint` on changed frontend/test files; run `npm run typecheck:frontend`; run `npm run build:client`; confirm `dist/index.html` references the new asset; use an authenticated Playwright run against `http://127.0.0.1:3001` to open a session with known history, click a different session with distinct known history, assert URL and pane text change, and record that each unchanged selection issues a bounded single message request rather than a rerender loop.
  **Summary:** Stabilized selected and committed identities in `useChatSessionState.ts` from primitive session/project inputs, retaining the prior object when its exact identity key is unchanged and narrowing message/external-load dependencies so store/loading rerenders no longer restart requests. Added `stabilizeSessionIdentity` plus focused unchanged-versus-A-to-B tests, and extended loading-owner coverage proving a directly started B request supersedes A. No store coalescing or remount workaround was needed. Focused tests (13), scoped ESLint, frontend typecheck, and client build pass; `dist/index.html` and the running server reference fresh `index-C-roHXvZ.js`. Authenticated Playwright opened A, observed `A Small Light`, clicked B, reached B's URL and test transcript with A absent. Foreground requests were bounded: A had 3 requests and stayed at 3 over 4 additional seconds; B had 2 requests and stayed at 2 over 5 additional seconds. Background cache synchronization continued across other session ids and issued one later request for inactive A, but neither active selection continuously restarted as in the prior 17-in-12-second loop.

# CHANGELOG

- **ID 1:** Made sidebar New Session and session selection single-intent transitions, atomically selecting owning project/session before one navigation; added passing focused regressions and regenerated the verified client entry asset.
- **ID 2:** Stabilized exact chat selection identities and effect dependencies, added passing identity/request-ownership regressions, and regenerated the client build; authenticated Playwright validation remains blocked by the unavailable scripted Playwright runtime.
- **ID 2 validation:** Authenticated Playwright confirmed A-to-B URL/transcript replacement with stale A text absent; active request counts stabilized at A=3 over an extra 4s and B=2 over an extra 5s, while the server served `/assets/index-C-roHXvZ.js`.
