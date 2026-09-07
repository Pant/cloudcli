# Frontend Chat and Session State

## Scope and boundaries

This chapter maps the browser-side conversation transcript: loading and retaining session history, optimistic sends, WebSocket reconciliation, durable IndexedDB caching, conversion into render models, composer queueing, and tool-result presentation. Backend history endpoints and WebSocket protocol ownership are adjacent concerns; see `backend-realtime-websocket-sessions.md` and `shared-contracts-api-transport.md` when changing wire contracts.

## Primary entry points

| Symbol | Path | Role |
|---|---|---|
| `ChatInterface` | `src/components/chat/view/ChatInterface.tsx` | Composes session, composer, provider, permission, and realtime hooks into the chat surface. |
| `useChatSessionState` | `src/components/chat/hooks/useChatSessionState.ts` | Selects the active session, warms history, derives rendered messages, retains viewport/history visibility, and exposes message mutations. |
| `useChatComposerState` | `src/components/chat/hooks/useChatComposerState.ts` | Owns draft/attachment/command submission, creates a session before its first send, emits `chat.send`, and inserts the optimistic user row. |
| `useChatRealtimeHandlers` | `src/components/chat/hooks/useChatRealtimeHandlers.ts` | Handles subscribed server events, processing/permission side effects, sequenced ingestion, and replay-gap recovery. |
| `useSessionStore` | `src/stores/useSessionStore.ts` | Central per-session transcript/cache store and the action/selector API consumed by chat and realtime code. |
| `ToolRenderer` | `src/components/chat/tools/ToolRenderer.tsx` | Routes tool-use inputs/results to configured compact, collapsible, diff, patch, plan, task, question, and subagent displays. |

## Session store model and API

`useSessionStore` keeps a `Map<string, SessionSlot>` in refs and only ticks React when the active, visible chat slot changes. Sequenced stream chunks are accepted immediately, but foreground materialization/persistence uses an explicit 100 ms production cadence; a mounted hidden chat coalesces pending chunks until activation or a terminal/generation flush. A slot separates canonical `serverMessages` from provisional/live `realtimeMessages`; `merged` is recomputed for rendering. `SessionSnapshot` provides stable selector output keyed by `viewRevision`. `MAX_IN_MEMORY_SESSION_SLOTS` and `evictInactiveSessionSlots` bound inactive in-memory slots.

### Important actions and selectors

| Category | Symbols | Purpose |
|---|---|---|
| Selection | `setActiveSession`, `setChatSurfaceActive`, `prioritizeSession`, `getActiveSessionId` | Track the viewed/high-priority session and whether the preserved chat surface is visible; activation flushes its latest pending stream once. |
| Initial load | `hydrateFromCache`, `warmSession`, `fetchFromServer` | Race cache hydration with the authoritative history request; accept only current generation/ticket results. |
| History/recovery | `fetchMore`, `refreshFromServer`, `recoverSession`, `synchronizeSession` | Support legacy pagination, canonical replacement, replay-gap REST recovery, and complete cache synchronization. |
| Realtime | `appendRealtime`, `appendRealtimeBatch`, `ingestRealtimeEvent`, `getRealtimeCursor`, `getSubscriptionTarget` | Add optimistic/unsequenced rows or enforce generation/sequence ordering for server events and replay subscriptions. |
| Streaming/status | `setStatus`, `updateStreaming`, `finalizeStreaming`, `clearRealtime` | Maintain processing state and materialized streaming rows; sequenced streams primarily flow through `ingestRealtimeEvent`. |
| Selectors | `getMessages`, `getSessionSlot`, `getSessionSnapshot`, `getCanonicalResponseMetadata`, `isCanonicalResponseMetadataHydrated`, `isStale` | Read merged transcript, load metadata, token usage, canonical revision, and stable render snapshots. |
| Cache controls | `cacheCoordinator`, `forceSyncCache`, `clearCache`, `getCacheStats`, `requestCachePersistence`, `refreshCacheStorageStatus` | Expose background/manual synchronization and browser-storage diagnostics. |

`computeMerged` (internal to `useSessionStore.ts`) chronologically combines canonical and realtime rows, calling `removeOptimisticUserEchoes` and pruning rows now represented by the server. It also avoids adjacent assistant echoes caused by delayed provider indexing.

## Persistence, reconciliation, and history policy

| Symbol | Path | Responsibility |
|---|---|---|
| `SessionMessageCacheRepository` | `src/stores/sessionMessageCache.ts` | IndexedDB repository namespaced by user and session. `hydrateSession`, `replaceAuthoritativeSession`, `upsertRealtimeMessage`, `deleteRealtimeMessage`, metadata/revision reads, cleanup, stats, and clear operations fail open to the network path. |
| `getUserCacheNamespace` | `src/stores/sessionMessageCache.ts` | Derives the account boundary used by all persistent records. |
| `requestPersistentStorage`, `inspectBrowserStorage` | `src/stores/sessionMessageCache.ts` | Request durable browser storage and report support/quota/persistence status. |
| `SessionMessageCacheCoordinator` | `src/stores/SessionMessageCacheCoordinator.tsx` | Requests durable storage once per stable provider mount through stable store methods; equal storage reports retain the existing status/context identity while genuine field changes propagate. |
| `SessionCacheSyncCoordinator` | `src/stores/sessionMessageCacheCoordinator.ts` | Serializes manifest reconciliation/clear operations, deduplicates per-session sync, prioritizes invalidated and active sessions, and applies automatic/manual concurrency limits. |
| `parseSessionCacheManifest`, `planSessionCacheSync` | `src/stores/sessionMessageCacheCoordinator.ts` | Strictly normalize manifest rows and select missing, changed, invalidated, or forced complete-history work. |
| `getPersistableMessageEvent`, `canRunSessionCacheSync` | `src/stores/sessionMessageCacheCoordinator.ts` | Filter control frames from durable messages and gate automatic work by visibility/connectivity. |
| `removeOptimisticUserEchoes` | `src/stores/sessionMessageReconciliation.ts` | One-to-one fingerprint/time-window matching removes `local_` user rows once canonical echoes arrive. |
| `buildSessionMessagesUrl`, `normalizeCompleteHistoryState` | `src/stores/sessionHistoryPolicy.ts` | Express complete-versus-paginated request semantics and authoritative response state. |
| `getVisibleHistoryWindow`, `reconcileLocalHistoryVisibility`, `revealLocalHistoryWindow`, `revealAllLocalHistory` | `src/stores/sessionHistoryPolicy.ts` | Keep the full transcript in the store while incrementally revealing local render windows. |
| `SessionHistoryWorkerPool`, `parseSessionHistoryEnvelopeAsync` | `src/utils/sessionHistoryValidation.ts` | Validate/normalize large history envelopes through bounded workers, with abort support and synchronous chunk fallback. |

Only persistable message kinds enter IndexedDB; transient status, permission, stream-end, completion, and session-created control frames are excluded. Complete canonical writes replace server rows while retaining unreconciled realtime rows and sync metadata (`revision`/`canonicalRevision`, counts, readiness, provider, archive state).

## Message lifecycle

```mermaid
sequenceDiagram
  participant UI as ChatInterface / useChatSessionState
  participant Store as useSessionStore
  participant Cache as SessionMessageCacheRepository
  participant API as session history API
  participant Composer as useChatComposerState
  participant WS as WebSocket handlers

  UI->>Store: setActiveSession + warmSession(sessionId)
  par fast durable render
    Store->>Cache: hydrateSession(namespace, sessionId)
    Cache-->>Store: canonical + unreconciled realtime rows
  and authoritative load
    Store->>API: apiClient.sessionHistory(sessionId, revision?)
    API-->>Store: complete transcript / notModified
  end
  Store->>Store: computeMerged + snapshot revision
  UI->>UI: normalizedToChatMessages + stabilizeRenderedMessages

  Composer->>Composer: upload attachments / create session if needed
  Composer->>WS: chat.send(sessionId, content, options)
  Composer->>Store: appendRealtime(local user message)
  Store->>Cache: upsertRealtimeMessage
  WS->>Store: ingestRealtimeEvent(generation, seq)
  Store->>Store: reduce/materialize stream; reject duplicate/stale/gap
  Store->>Cache: persist visible realtime rows
  WS->>Store: recoverSession on sequence gap
  Store->>API: forced canonical refresh
  Store->>Store: remove optimistic/server-owned realtime echoes
  Store->>Cache: replaceAuthoritativeSession
```

### Representative flows

1. **Open/load:** `useChatSessionState` subscribes using `getSubscriptionTarget`, begins its loading owner, and calls `warmSession`. Cache hydration may expose rows immediately but deliberately leaves `fetchedAt = 0`; `fetchFromServer` remains authoritative, uses revision-aware `notModified`, updates the snapshot, and queues `replaceAuthoritativeSession`. The hook transforms `getMessages()` through `normalizedToChatMessages` and `stabilizeRenderedMessages`, then applies local visibility/viewport policy.
2. **Send:** `useChatComposerState` uploads attachments and, for a new conversation, POSTs `/api/providers/sessions` to obtain the stable session ID before emitting `chat.send`. After socket acceptance it calls `addMessage`; `useChatSessionState` converts the `ChatMessage` and `appendRealtime` persists the optimistic row. Processing state drives the activity indicator until `complete`.
3. **Realtime/reconcile:** `useChatRealtimeHandlers` routes sequenced events into `ingestRealtimeEvent`. `acceptSequencedEvent` updates cursors immediately, rejects duplicates/stale generations, and reports gaps; gaps call `recoverSession`. Stream deltas accumulate without prefix copies and materialize at most every 100 ms only for the active visible chat. Hidden or inactive streams coalesce; activation and terminal/generation events flush the latest text. A later canonical refresh prunes IDs and optimistic fingerprints already owned by server history, then atomically rewrites the durable session.
4. **Queued follow-up:** `useChatComposerState` snapshots queued text/options/attachments via `writeQueuedMessage`. For inactive sessions, `useQueuedMessageAutoSend`/`flushQueuedMessageAutoSend` waits for processing to end and an open socket, emits `chat.send`, clears the claim, and marks processing. The active session is excluded because its composer owns flushing and command/file behavior.
5. **Watcher refresh:** `useProjectsState` increments the external transcript revision for an inactive viewed `session_upserted` event. `useChatSessionState` owns consumption per selected identity: each revision is consumed once (including suppression while streaming), selection changes baseline the current revision, and the effect depends on stable `useSessionStore` methods rather than the changing aggregate store object.
6. **Viewport revisions:** `getViewportRevisionAction` classifies a revision as stream-only only when exactly one existing `stream_delta` row changes content. Bottom-owned stream commits receive one direct pin and never start the multi-frame settle loop; anchor-owned or search-active views remain stationary. Session switches, cache/canonical replacement, stream finalization, local reveal, and other structural revisions continue through bounded RAF/ResizeObserver settlement.

## Rendering pipeline and components

| Symbol | Path | Role |
|---|---|---|
| `normalizedToChatMessages`, `stabilizeRenderedMessages` | `src/components/chat/hooks/useChatMessages.ts` | Convert normalized kinds into UI `ChatMessage` rows, attach `tool_result` to matching `tool_use`, suppress control frames/orphan paired results, and preserve equivalent row identity. |
| `ChatMessagesPane` | `src/components/chat/view/subcomponents/ChatMessagesPane.tsx` | Renders the visible transcript window and scrolling/loading affordances; the manually compensated viewport disables native scroll anchoring, coalesces scroll/resize notifications, and revises its virtual window only when scroll or viewport metrics change. Each mounted row owns a stable ResizeObserver lifecycle, and height revisions occur only for genuine measurement changes while preserving scroll compensation. |
| `MessageComponent` | `src/components/chat/view/subcomponents/MessageComponent.tsx` | Dispatches user, assistant, thinking, error, interactive, attachment, and tool-use row presentation. |
| `Markdown`, `StreamingMarkdown` | `src/components/chat/view/subcomponents/Markdown.tsx` | Route partial assistant streams through selectable whitespace-preserving text/fence presentation without remark/math/highlighting; finalized rows use the rich Markdown pipeline. |
| `QuestionFormCard` | `src/components/chat/view/subcomponents/QuestionFormCard.tsx` | Presents structured interactive questions and returns a normal send-path answer transcript. |
| `ChatMessageFiles`, `ChatMessageImages`, `MessageCopyControl` | `src/components/chat/view/subcomponents/` | Attachment previews and message copy actions. |
| `useChatComposerState` | `src/components/chat/hooks/useChatComposerState.ts` | Core input state; coordinates slash commands, files, queued drafts, send options, and optimistic insertion. |
| `useFileMentions`, `useSlashCommands`, `useVoiceInput` | `src/components/chat/hooks/` | Composer extensions for project-file mentions, commands/skills, and voice transcription. |

## Tool rendering extension areas

- Add or alter a tool's presentation in `TOOL_CONFIGS`/`getToolConfig` in `src/components/chat/tools/configs/toolConfigs.ts`; `shouldHideToolResult` controls separate result visibility.
- Extend `ToolRenderer` when a new `ToolDisplayConfig` display/content type is required. Reuse `OneLineDisplay`, `CollapsibleDisplay`, `BashCommandDisplay`, or add a lazy family under `src/components/chat/tools/components/` for heavy renderers.
- Add specialized content under `components/ContentRenderers/` (`MarkdownContent`, `FileListContent`, `TodoListContent`, `TaskListContent`, `QuestionAnswerContent`, `TextContent`). File-opening and diff behavior enters through `onFileOpen` and `createDiff`.
- `Task` is special: `normalizedToChatMessages` builds `subagentState`, and `ToolRenderer` delegates it to `SubagentContainer`. New nested-agent semantics must update both normalization and rendering.
- Permission-specific UI is registered through `registerPermissionPanel`/`getPermissionPanel` in `src/components/chat/tools/configs/permissionPanelRegistry.ts` rather than hard-coding provider panels into the generic renderer.
- Search tool payload normalization belongs in `normalizeSearchToolResult` (`src/components/chat/tools/searchResultNormalizer.ts`).

## Change guide

- **History shape or validation:** coordinate `apiClient.sessionHistory`, `parseSessionHistoryEnvelopeAsync`, normalized message types, cache validity checks, and contract/backend maps.
- **Merge/deduplication:** start at `computeMerged`, `pruneRealtimeSupersededByServer`, and `removeOptimisticUserEchoes`; preserve repeated-send one-to-one behavior.
- **Realtime protocol/order:** start at `useChatRealtimeHandlers`, `ingestRealtimeEvent`, and subscription cursor helpers; recovery must retain cache/network generation guards.
- **Cache policy:** change `SessionMessageCacheRepository` for record layout and `SessionCacheSyncCoordinator` for manifest scheduling. IndexedDB failures must remain non-fatal to chat.
- **Visible history/scrolling:** change `sessionHistoryPolicy.ts`, `useChatSessionState`, and `sessionViewport.ts`; keep direct stream-follow separate from structural settlement and do not confuse local reveal windows with network pagination.
- **Streaming text rendering:** keep `isStreaming` on the stable assistant row and route only that partial state through `StreamingMarkdown`; final text must return to the existing rich Markdown/math/file-link/highlighting path.
- **Send/queue behavior:** change `useChatComposerState`, `chatStorage.ts`, and `useQueuedMessageAutoSend`; maintain the stored-message claim that prevents double sends.

## Focused tests and validation

| Area | Focused tests |
|---|---|
| Store merge, helper, retention | `src/stores/sessionStore.helpers.test.ts`, `src/stores/sessionRetention.test.ts` |
| IndexedDB persistence | `src/stores/sessionMessageCache.test.ts` |
| Manifest synchronization/clear/concurrency | `src/stores/sessionMessageCacheCoordinator.test.ts` |
| Optimistic echo removal | `src/stores/sessionMessageReconciliation.test.ts` |
| Complete/local history policy | `src/stores/sessionHistoryPolicy.test.ts` |
| History envelope/worker boundary | `src/utils/sessionHistoryValidation.test.ts` |
| Queue dispatch | `src/hooks/useQueuedMessageAutoSend.test.ts` |
| Session load and render conversion | `src/components/chat/hooks/sessionMessageLoading.test.ts`, `src/components/chat/hooks/useChatMessages.test.ts`, `src/components/chat/utils/messageKeys.test.ts` |
| Tool configuration/render content | `src/components/chat/tools/configs/toolConfigs.test.ts`, `src/components/chat/tools/searchResultNormalizer.test.ts`, `src/components/chat/tools/components/ContentRenderers/QuestionAnswerContent.test.tsx` |
| Transcript viewport | `src/components/chat/hooks/sessionViewport.test.ts`, `src/components/chat/view/subcomponents/transcriptWindow.test.ts` |

Validation should trace one complete open, one accepted `chat.send`, one sequenced stream/complete path, and one replay-gap recovery while checking every cited symbol at its defining path.
