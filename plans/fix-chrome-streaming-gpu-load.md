# Fix Chrome Streaming GPU Load

## CONTEXT

### Files

./src/stores/useSessionStore.ts - Accepts realtime stream deltas and currently commits the growing visible stream row every 16 ms, notifying the active React tree and persisting each committed row.
./src/stores/sessionStore.helpers.ts - Accumulates stream chunks without per-delta string copies and is the appropriate home for pure stream cadence/state policy.
./src/stores/sessionStore.helpers.test.ts - Covers high-volume stream accumulation, finalization, ordering, and helper policies.
./src/stores/sessionStoreProvider.tsx - Creates the production session store and can provide visibility-aware stream commit policy if needed.
./src/components/chat/hooks/useChatSessionState.ts - Converts every active-store update into render models and currently starts viewport settlement for each store snapshot revision.
./src/components/chat/hooks/sessionViewport.ts - Defines viewport settlement, which may run for up to 60 animation frames per revision.
./src/components/chat/hooks/sessionViewport.test.ts - Focused viewport ownership and settlement tests.
./src/components/chat/hooks/useChatMessages.ts - Rebuilds chat render models from the complete visible normalized transcript on each store update.
./src/components/chat/view/subcomponents/Markdown.tsx - Runs the full ReactMarkdown/remark pipeline for the ever-growing streaming assistant response; `isStreaming` only avoids syntax highlighting after parsing.
./src/components/chat/view/subcomponents/MessageComponent.tsx - Routes streaming assistant text through `Markdown` and therefore reparses the full growing response for each visible stream commit.
./src/components/chat/view/subcomponents/ChatMessagesPane.tsx - Renders/window-measures the transcript and owns ResizeObservers and window revision updates.
./src/components/chat/view/subcomponents/transcriptWindow.ts - Contains pure transcript window/measurement policy suitable for stream-specific viewport tests.
./src/components/chat/view/subcomponents/transcriptWindow.test.ts - Focused tests for bounded mounted rows and delayed growth compensation.
./src/components/chat/view/ChatInterface.tsx - Composes session state, realtime handlers, transcript rendering, and the active chat surface.
./src/components/chat/types/types.ts - Defines chat surface contracts and can carry visibility or stream rendering signals if needed.
./src/components/main-content/view/MainContent.tsx - Keeps the chat tree mounted after first use and hides it with `display: none` on other tabs, so realtime React work can continue even when chat is not visible.
./src/components/main-content/types/types.ts - Defines the shell-to-chat contract for active surface state.
./src/components/main-content/view/startupBoundaries.test.ts - Existing static/source-level validation for main-content lazy mounting and tab behavior.
./src/components/main-content/view/subcomponents/MainContentHeader.test.tsx - Existing source-level coverage for main-content composition changes.
./src/lib/performanceDiagnostics.ts - Existing client performance diagnostics; any bounded render/stream instrumentation should integrate here rather than create a parallel logging system.
./e2e/performance.spec.ts - Production Chromium performance project, currently limited to startup request/byte budgets.
./codemaps/frontend-chat-session-state.md - Must reflect stream commit/render/viewport ownership changes.
./codemaps/frontend-app-shell-navigation.md - Must reflect visible-versus-mounted chat behavior if the active tab is propagated.
package.json - Defines focused frontend tests, typecheck, lint, build, and production-performance validation.

The previous remediation removed unconditional terminal WebGL and confirmed infinite decorative animations, but it did not address the authenticated active-chat render loop. A fresh unauthenticated CloudCLI page was profiled for five seconds in Chromium: `document.getAnimations()` was empty, there were zero DOM mutations, no canvases/videos, and Chrome CDP reported approximately 1.2 ms total task time over ten seconds. This rules out the service worker, static login shell, and a global idle animation as the source of the reported 40% Chrome GPU use.

The active chat path contains a direct frame-rate hot loop. `useSessionStore` defaults `realtimeCommitIntervalMs` to 16 ms. Each commit materializes the complete accumulated response, replaces the stream row, recomputes merged messages, increments the view revision, writes the realtime row to IndexedDB, and notifies React. `useChatSessionState` then normalizes the visible transcript and the growing assistant response is passed through ReactMarkdown/remark again. The viewport revision layout effect also invokes `startViewportSettle` for every revision; that routine can read layout, write `scrollTop`, and request another frame for up to 60 frames. Repeated stream commits cancel/restart this settlement while the response is still growing.

`MainContent` deliberately preserves the chat subtree after first invocation and only applies `display: none` when another tab is active. Browser painting is suppressed by `display: none`, but WebSocket ingestion, store notifications, React normalization, Markdown parsing, and effect work can continue unless chat visibility is explicitly part of the stream/render policy.

The relevant code maps and focused tests show that complete canonical history, optimistic/realtime reconciliation, viewport ownership, and transcript windowing are intentional behavior and must remain intact. The worktree also contains unrelated in-progress history visibility and performance fixes; implementations must preserve them. This task is frontend-only unless validation uncovers a concrete backend dependency. No version-control operations were requested.

## ANALYSIS

The reported symptom is Chrome GPU usage during the only active resource-consuming surface, and the code-level evidence points to render/compositor pressure during token streaming rather than an idle CSS animation. The 16 ms commit cadence attempts to render at roughly 60 updates per second. Every update grows the same text node but also rebuilds render models, runs Markdown parsing over the full response prefix, changes row height, invokes ResizeObservers, and starts a multi-frame viewport correction loop. That combination can continuously submit layout/paint/composite work even though the semantic requirement is only that streaming text feel responsive.

The highest-value correction is coordinated backpressure across store, rendering, and viewport ownership:

1. Commit visible stream text at a bounded human-readable cadence instead of every 16 ms. A foreground chat generally needs about 8–12 updates per second, while a hidden chat needs no visible commits until it becomes visible or the stream ends. Incoming sequence acceptance must remain immediate so replay/gap correctness is unaffected.
2. Do not parse the full Markdown AST on each partial response. Render streaming text through a lightweight whitespace-preserving path, then switch to the existing Markdown/math/highlighting pipeline exactly once when finalized.
3. Do not run the 60-frame viewport settlement algorithm for each stream-text revision. If the user is following the bottom, perform at most one bottom pin per bounded visible commit; if the user has scrolled up, preserve the anchor and do no automatic stream scrolling. Keep the existing settlement algorithm for session changes, canonical loads, images, code highlighting, and other structural layout changes.
4. Propagate active-tab visibility so a mounted but hidden chat can accumulate realtime chunks without repeatedly rendering them. On return to chat, materialize the latest stream once and restore the viewport safely.

These changes trade imperceptible per-token immediacy for much lower main-thread, layout, paint, and GPU workload. They must not delay final completion, lose chunks, break sequence cursors, suppress hidden-session state, or alter canonical persistence. Tests should measure observable policy—bounded commits, lightweight partial rendering, no stream-triggered settle loop, hidden-surface coalescing—rather than relying only on class-name checks. Production Chromium validation should add an active synthetic streaming workload because startup-only metrics cannot detect this regression.

## PLAN

1. Add visibility-aware stream backpressure so incoming deltas are accepted immediately but visible React/IndexedDB commits are bounded and hidden chat surfaces coalesce until visible/final.
2. Replace full Markdown parsing during partial streaming with a lightweight text/code-fence presentation and retain the existing rich renderer for finalized messages.
3. Separate streaming viewport following from structural viewport settlement so token growth cannot restart a 60-frame layout loop on each commit.
4. Add a production Chromium synthetic-stream performance regression test, rebuild/reload CloudCLI, and compare active-stream rendering metrics with the current 16 ms behavior.

## GUIDELINES

- Preserve all unrelated worktree changes, especially existing transcript reveal-all, external-refresh, PWA, and backend performance fixes.
- Keep WebSocket sequence acceptance and replay-gap detection immediate; only visible materialization/render/persistence cadence may be throttled.
- Always flush the latest pending stream content on `stream_end`, `complete`, generation change, session activation, and disposal where appropriate.
- Hidden/inactive chat surfaces must retain correct latest state without continuously notifying React; returning to chat must display the current stream promptly.
- Do not alter canonical history semantics, stable app-session IDs, optimistic message reconciliation, token metadata, or cache fail-open behavior.
- Streaming text must remain selectable, copyable, whitespace-preserving, and readable; finalized content must continue supporting Markdown, tables, links, math, code highlighting, and file opening.
- Preserve user scroll intent. Never pull a scrolled-up user to the bottom because tokens arrive.
- Avoid new infinite animations, permanent `will-change`, canvas/WebGL renderers, or unbounded animation-frame loops.
- Update affected code maps in the same TODO item as the behavior change.
- Do not branch, stage, commit, push, or otherwise modify VCS state.

## TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Implement visibility-aware realtime stream commit backpressure. Replace the 16 ms production default with an explicit bounded foreground cadence, accept all sequenced deltas immediately into pending chunks, avoid active React notifications and repeated IndexedDB writes while chat is hidden, and flush the latest materialized stream immediately on finalization, generation change, or return to the active chat surface. Add pure policy/tests and update the chat code map.
  **Files:**
  ./src/stores/useSessionStore.ts - Apply bounded visible commits, hidden coalescing, immediate terminal flushes, and reduced persistence churn.
  ./src/stores/sessionStore.helpers.ts - Add pure visibility/cadence/flush policy helpers where useful.
  ./src/stores/sessionStore.helpers.test.ts - Cover high-volume delta acceptance, bounded commit decisions, hidden coalescing, activation flush, terminal flush, and generation rollover.
  ./src/stores/sessionStoreProvider.tsx - Supply document/chat visibility state to the session store if production ownership requires it.
  ./src/components/chat/view/ChatInterface.tsx - Propagate the active chat surface signal to the store without coupling sequence ingestion to rendering.
  ./src/components/chat/types/types.ts - Add the minimal active-surface contract if required.
  ./src/components/main-content/view/MainContent.tsx - Pass explicit `isActive` state to the preserved chat subtree.
  ./src/components/main-content/types/types.ts - Keep shell/chat contracts typed.
  ./src/components/main-content/view/startupBoundaries.test.ts - Verify preserved mounting plus active-surface propagation.
  ./codemaps/frontend-chat-session-state.md - Document bounded stream materialization and hidden-surface behavior.
  ./codemaps/frontend-app-shell-navigation.md - Document preserved-but-inactive chat ownership.
  **Acceptance criteria:** A 10,000-delta stream preserves exact content/order and realtime cursor while visible commits are capped by the configured cadence rather than delta/frame rate; a hidden chat does not notify/render/persist on every delta; returning to chat displays the latest accumulated content promptly; terminal/generation events flush exactly once with no lost text; active session switching and inactive-session streams remain correct; the production default is materially slower than 16 ms and is explicit/tested.
  **Validation:** Run focused session store/helper and main-content tests, `npm run typecheck:frontend`, and narrow lint for changed files. Add deterministic fake-time/scheduler tests rather than wall-clock-only assertions.
  **Summary:** Added visibility-aware stream coalescing in `useSessionStore.ts`, an explicit 100 ms production cadence in `sessionStoreProvider.tsx`, active-surface propagation from `MainContent` through `ChatInterface`, pure cadence policy/high-volume tests, and both required code-map updates. Sequenced deltas still advance the cursor immediately; only the active visible session schedules materialization, activation/session selection flushes pending text, and terminal/generation paths materialize before one final notification/persistence path. Focused helper/main-content tests and narrow ESLint passed, and integrated `npm run typecheck:frontend` passed after the concurrent TODO 2 fixtures completed. No VCS operations were performed.

- [x] **ID:** 2 | **Batch:** 1
  **Task:** Add a lightweight partial-response renderer so growing streaming assistant text does not run ReactMarkdown/remark/math/highlighting over the entire prefix on each commit. Preserve whitespace and readable fenced-code presentation during streaming, and switch to the existing rich Markdown renderer after finalization. Add focused rendering tests and update the chat code map.
  **Files:**
  ./src/components/chat/view/subcomponents/Markdown.tsx - Separate lightweight streaming presentation from finalized rich Markdown rendering.
  ./src/components/chat/view/subcomponents/MessageComponent.tsx - Route only partial assistant stream rows through the lightweight path while preserving user/finalized behavior.
  ./src/components/chat/hooks/useChatMessages.ts - Preserve stable streaming/final identities and final transition semantics.
  ./src/components/chat/hooks/useChatMessages.test.ts - Verify partial-to-final render model behavior and stable identity.
  ./src/components/chat/view/subcomponents/Markdown.test.tsx - Add focused partial text/fence/final Markdown behavior tests if a new test file is appropriate.
  ./codemaps/frontend-chat-session-state.md - Document partial versus finalized render paths.
  **Acceptance criteria:** Partial streaming assistant text does not instantiate the ReactMarkdown/remark/math/syntax-highlighting pipeline; text, line breaks, inline punctuation, and open/unterminated fenced code remain readable and selectable; finalized text uses the unchanged rich Markdown renderer; copy/speak controls and message identity remain stable; no content flashes, duplicates, or disappears at finalization.
  **Validation:** Run focused Markdown/message normalization tests, `npm run typecheck:frontend`, narrow lint, and client build.
  **Summary:** Added a dedicated `StreamingMarkdown` path in `Markdown.tsx` that renders selectable whitespace-preserving plain text and readable closed or unterminated fenced code without invoking ReactMarkdown, remark, math detection/rendering, or syntax highlighting. Existing `MessageComponent` routing through `isStreaming` now selects this path while finalized rows retain the unchanged rich renderer and existing copy/speak controls. Added focused streaming presentation and partial-to-final normalization/identity tests, and documented the render split in the chat code map. Focused tests (6/6), narrow ESLint, `npm run typecheck:frontend`, and `npm run build:client` passed.

- [x] **ID:** 3 | **Batch:** 1
  **Task:** Prevent realtime stream revisions from starting or restarting the general multi-frame viewport settlement loop. Introduce a stream-aware viewport policy: bottom-following users receive at most one direct bottom pin per bounded stream commit, scrolled-up/searching users receive no automatic stream scroll, and structural changes continue using the existing settlement/ResizeObserver behavior. Add focused viewport tests and update the chat code map.
  **Files:**
  ./src/components/chat/hooks/useChatSessionState.ts - Distinguish stream-only revisions from structural revisions and use bounded bottom following.
  ./src/components/chat/hooks/sessionViewport.ts - Add pure stream-follow versus structural-settlement policy.
  ./src/components/chat/hooks/sessionViewport.test.ts - Cover bottom, anchor, search, session-switch, stream, and structural revision decisions.
  ./src/components/chat/view/subcomponents/ChatMessagesPane.tsx - Coordinate row measurement/window updates without redundant stream-triggered revisions if needed.
  ./src/components/chat/view/subcomponents/transcriptWindow.ts - Add pure measurement coalescing policy only if required.
  ./src/components/chat/view/subcomponents/transcriptWindow.test.ts - Preserve bounded mounted rows and verify stream growth compensation.
  ./codemaps/frontend-chat-session-state.md - Document stream-follow and structural settlement ownership.
  **Acceptance criteria:** A stream commit never launches the up-to-60-frame structural settle loop; users at bottom remain pinned with one bounded operation per visible commit; users scrolled up or in search remain stationary; session changes, cache/canonical loads, delayed images, highlighted code, local reveal, and explicit scroll-to-bottom retain current robust settlement behavior; no orphaned RAF or ResizeObserver remains after session changes/unmount.
  **Validation:** Run focused viewport/transcript-window/chat loading tests, `npm run typecheck:frontend`, narrow lint, and client build.
  **Summary:** Implemented pure stream-versus-structural revision classification in `sessionViewport.ts`, direct single-operation bottom following in `useChatSessionState.ts`, focused viewport policy tests, and code-map documentation. Existing reveal-all, external-refresh, transcript windowing/growth compensation, structural settle cleanup, and observer cleanup paths were preserved. Focused viewport/transcript/chat-loading tests, narrow ESLint, client build, and integrated `npm run typecheck:frontend` passed after the concurrent TODO 2 fixtures completed.

- [x] **ID:** 4 | **Batch:** 2
  **Task:** Add a production Chromium active-stream performance regression scenario, run integrated frontend validation, rebuild/reload CloudCLI, and report before/after rendering metrics and live behavior. The scenario should drive thousands of synthetic stream deltas through representative policy/render code, measure visible commit count, script/task/layout/style work, DOM mutation/animation state, and verify hidden-tab coalescing and final content. Fix task-related warnings or regressions discovered by validation.
  **Files:**
  ./e2e/performance.spec.ts - Add active visible and hidden synthetic-stream performance budgets in the production-performance project.
  ./src/lib/performanceDiagnostics.ts - Add only bounded non-sensitive stream/render measurement helpers if needed by the test/runtime.
  ./package.json - Use existing production performance/build/test commands.
  ./plans/fix-chrome-streaming-gpu-load.md - Record final validation and live measurements in this item's Summary.
  **Acceptance criteria:** The production Chromium scenario demonstrates bounded visible commits well below 60/s, zero continuing hidden-surface commits, exact final text, no active infinite animations, and materially lower task/layout/style/mutation work than the 16 ms baseline; frontend typecheck, focused tests, lint, client build, production-performance tests, and reload pass; live CloudCLI continues streaming correctly and the remaining Chrome GPU issue is either materially reduced or reported with exact residual evidence rather than speculation.
  **Validation:** Run all focused tests from IDs 1–3, `npm run typecheck:frontend`, `npm run lint`, `npm run build:client`, `npm run test:e2e:performance`, then the reload skill with `frontend`. Collect a bounded post-reload browser/CDP sample under idle and active synthetic stream workloads, including commit/update rate, TaskDuration, ScriptDuration, LayoutDuration, RecalcStyleDuration, DOM mutation count, active animations, and mounted transcript rows. Do not expose credentials.
  **Summary:** Added an unauthenticated production-Chromium synthetic stream regression in `e2e/performance.spec.ts` that drives 5,000 representative deltas through 100 ms visible materialization, lightweight text rendering, direct bottom following, hidden coalescing, and terminal flush while collecting CDP and DOM evidence. The post-reload bounded sample recorded 8 commits (7.39/s), 0 hidden commits, exact final content, 8 mutations, 0 running animations, 41 mounted rows, and active deltas of TaskDuration 0.150649 s, ScriptDuration 0.002533 s, LayoutDuration 0.0792 s, and RecalcStyleDuration 0.001089 s; the 250 ms idle sample was TaskDuration 0.006117 s with zero script/layout/style duration. All 45 focused tests available across IDs 1–3, frontend typecheck, full lint, client build/bundle budgets, all 4 production-performance tests, and the frontend reload workflow passed. No credentials, runtime diagnostics, or VCS operations were used; residual evidence is limited to the bounded synthetic unauthenticated workload rather than an authenticated provider stream or direct GPU-process counter.

## CHANGELOG
- 2026-08-19 TODO 3 [!]: Split stream-only viewport revisions from structural settlement, added one-shot bottom follow and focused policy coverage, and updated the chat code map. Focused tests, narrow lint, and client build passed; frontend typecheck is blocked by concurrent TODO 2 test fixtures missing required `provider` fields.
- 2026-08-19 TODO 2 [x]: Added lightweight whitespace-preserving partial assistant rendering with readable fenced code, retained rich finalized Markdown, covered partial-to-final identity/render behavior, and updated the chat code map; focused tests, narrow lint, frontend typecheck, and client build passed.
- 2026-08-19 TODO 1 [!]: Added 100 ms visibility-aware stream backpressure, hidden/inactive coalescing, activation and terminal/generation flush behavior, active-chat propagation, focused policy tests, and code-map updates. Focused tests and narrow lint passed; frontend typecheck is blocked by concurrent TODO 2 fixtures missing required `provider` fields.
- 2026-08-19 TODO 4 [x]: Added production Chromium active/hidden synthetic-stream budgets and CDP/DOM measurements; 5,000 deltas produced 8 commits (7.39/s), 0 hidden commits, exact content, 8 mutations, 0 animations, 41 rows, and bounded task/script/layout/style work. Focused tests, typecheck, full lint, client build, performance e2e, and frontend reload passed.
