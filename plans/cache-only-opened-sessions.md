# Cache Only Opened Sessions

## CONTEXT

CloudCLI has an authenticated, browser-persisted IndexedDB cache for normalized session messages. The session store already hydrates a session when it is opened, fetches its complete transcript, and writes the authoritative result plus subsequent realtime updates. A separate application-mounted coordinator currently performs startup, interval, browser-activity, reconnect, completion, and `session_upserted` manifest reconciliation, which discovers and caches histories for sessions the user has not opened. Cache Settings also exposes explicit “Sync all histories” and account-scoped clear operations. The requested change is frontend-only: remove automatic all-session synchronization while preserving opened-session caching, manual full synchronization, clear, statistics, user scoping, persistence, realtime write-through, and cache failure behavior.

### FILES

./src/stores/SessionMessageCacheCoordinator.tsx - The always-mounted component currently triggers automatic manifest reconciliation and therefore caches historical unopened sessions.
./src/stores/sessionMessageCacheCoordinator.ts - The coordinator owns manifest planning plus explicit force-sync and clear behavior that must remain available after automatic scheduling is removed.
./src/stores/sessionMessageCacheCoordinator.test.ts - Focused policy tests cover automatic/manual synchronization and must verify the preserved manual contract without requiring automatic all-session behavior.
./src/stores/sessionMessageCache.ts - The IndexedDB repository currently clears one account by cursor-deleting every message and metadata record, making large caches take over a minute.
./src/stores/sessionMessageCache.test.ts - Repository tests cover account-scoped clearing and need large-cache correctness plus fast bulk-deletion policy coverage.
./src/stores/useSessionStore.ts - The session store hydrates and authoritatively persists sessions as they are opened and exposes manual sync, clear, and persistence APIs.
./src/components/chat/hooks/useChatSessionState.ts - Ordinary selected-session loading calls the store's complete-history fetch and is the automatic caching boundary to preserve.
./src/App.tsx - The authenticated application mounts the background coordinator component whose responsibilities must no longer include automatic history synchronization.
./src/components/settings/view/tabs/CacheSettingsTab.tsx - Cache Settings retains explicit full-history synchronization and cache management controls.
./src/i18n/locales/en/settings.json - English cache-management copy currently says histories may be cached automatically later and must reflect opened-session-only automatic caching.
./src/i18n/locales/de/settings.json - German cache-management copy must preserve the shared locale key shape and reflect the new behavior.
./src/i18n/locales/fr/settings.json - French cache-management copy must preserve the shared locale key shape and reflect the new behavior.
./src/i18n/locales/it/settings.json - Italian cache-management copy must preserve the shared locale key shape and reflect the new behavior.
./src/i18n/locales/ja/settings.json - Japanese cache-management copy must preserve the shared locale key shape and reflect the new behavior.
./src/i18n/locales/ko/settings.json - Korean cache-management copy must preserve the shared locale key shape and reflect the new behavior.
./src/i18n/locales/ru/settings.json - Russian cache-management copy must preserve the shared locale key shape and reflect the new behavior.
./src/i18n/locales/tr/settings.json - Turkish cache-management copy must preserve the shared locale key shape and reflect the new behavior.
./src/i18n/locales/zh-CN/settings.json - Simplified Chinese cache-management copy must preserve the shared locale key shape and reflect the new behavior.
./src/i18n/locales/zh-TW/settings.json - Traditional Chinese cache-management copy must preserve the shared locale key shape and reflect the new behavior.
package.json - Defines focused frontend test, typecheck, lint, and client-build commands.

## ANALYSIS

The unwanted behavior is not the cache repository itself and not ordinary chat loading. It comes from `SessionMessageCacheCoordinator.tsx`, mounted for the whole authenticated application, invoking `coordinator.reconcile()` at startup, every 45 seconds, after focus/visibility/online recovery, on reconnect, and after session events. Reconciliation fetches the authoritative manifest, compares every manifest row with IndexedDB metadata, and downloads missing or changed transcripts. On a fresh cache, all historical sessions are missing, so the startup run caches everything without the user opening it.

The desired automatic boundary already exists: `useChatSessionState.ts` calls `sessionStore.fetchFromServer(selectedSessionId)` on an ordinary open; `fetchFromServer` hydrates any existing cache immediately, fetches complete network history, and persists that authoritative transcript by default. Realtime messages, streaming finalization, refreshes, and recovery for the active/viewed session also write through the same store. These paths should remain unchanged so a session begins or updates its cache through actual use.

Manual “Sync all histories” is explicitly user-triggered and is part of existing cache functionality rather than auto sync. It should continue to call `SessionCacheSyncCoordinator.forceSync()`, including manifest validation, active and archived histories, metadata-only rows, bounded manual concurrency, partial-failure reporting, account scoping, and serialization with clear. Cache statistics, clear, IndexedDB hydration, persistence requests, and fail-open behavior also remain intact.

The smallest robust implementation is to remove automatic `reconcile()` scheduling from the application-mounted component. The component can remain as a lightweight persistent-storage request if desired, avoiding broader provider/App churn, but it must not fetch the manifest or react to global events by downloading transcripts. Automatic reconciliation code inside the coordinator class can remain as dormant reusable policy unless removing it materially simplifies the implementation; keeping it minimizes risk to manual force-sync and clear. Tests should assert the opened-session/manual boundary rather than deleting coverage indiscriminately. Copy that promises automatic recaching must be corrected across locales: after clear, histories are cached again when opened or when the user explicitly selects Sync all histories, not merely because time or application activity passes.

Risks are accidentally disabling selected-session authoritative persistence, weakening manual force-sync, removing current-session refresh behavior, or leaving misleading Settings copy. No backend endpoint or database change is needed; the manifest endpoint can remain for explicit manual synchronization. No VCS operations are in scope.

The current account-clear implementation is also inefficient for large caches: `clearUserCache()` opens an index cursor for every matching message and calls `cursor.delete()` once per row. A cache containing many transcript messages therefore creates thousands of individual IndexedDB delete requests in one transaction and can remain pending for more than a minute. Both object stores use compound primary keys with `userNamespace` as the first key component, so one bounded `IDBKeyRange` over `[userNamespace]` through `[userNamespace, []]` can delete the entire account slice directly from each object store with `objectStore.delete(range)`. This preserves other users while reducing the operation to two range-delete requests plus transaction commit. The coordinator's write blocking, queued-write drain, explicit success contract, and zero-stat verification should remain unchanged.

## PLAN

1. Stop the authenticated application from automatically reconciling the all-session manifest while retaining the existing selected-session cache lifecycle, durable-storage request, explicit force-sync, clear, and cache coordination contracts.
2. Update Cache Settings locale copy so users are told that histories are cached when opened or through explicit synchronization, then validate locale parity and frontend integration.
3. Replace per-record account cache clearing with IndexedDB compound-key range deletion so even large existing caches are removed promptly without weakening account isolation or clear-result verification.

## GUIDELINES

- Automatic caching must be driven by opening/using a session through ./src/components/chat/hooks/useChatSessionState.ts and ./src/stores/useSessionStore.ts; do not add a replacement manifest scan, sidebar scan, startup preload, timer, focus/online refresh, reconnect sweep, or global event-driven transcript fetch.
- Preserve complete-history fetch and IndexedDB authoritative persistence for an opened session, cache hydration on reopen, active-session refresh/recovery, realtime/stream write-through, stable-id deduplication, user namespace isolation, write serialization, stale-write fencing, and fail-open cache errors.
- Preserve the explicit Cache Settings “Sync all histories” action and its manifest validation, active/archived inclusion, metadata-only rows, bounded manual concurrency, counts, partial failures, and serialization with account-scoped clear.
- Preserve cache statistics, clear behavior, and persistent-storage requests. Clearing should leave history absent until the session is opened again or the user explicitly synchronizes all histories.
- Implement fast account-scoped deletion against the compound primary-key ranges of both IndexedDB stores. Do not clear the whole database or another user's records, and do not loop through message rows with one delete request per record.
- Do not modify backend code or remove the manifest endpoint; it remains required by manual synchronization.
- Keep changes focused and avoid unrelated refactors. Follow existing TypeScript, React, import, test, and i18n conventions.
- Every locale under `src/i18n/locales/*/settings.json` must retain the same cache key shape and valid JSON. English is the source meaning; translated wording may be concise but must not claim automatic background recaching.
- Run focused frontend Node tests explicitly with `node --import tsx --test ...`, plus frontend typecheck, targeted ESLint, and `npm run build:client` for integration changes.

## TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Remove automatic all-session cache synchronization from the authenticated application runtime while preserving the existing cache-on-open lifecycle and every explicit/manual cache-management operation. Refactor the mounted cache coordinator so startup, timer, focus/visibility/online, reconnect, completion, and `session_upserted` activity do not invoke manifest reconciliation or fetch unopened histories; retain durable-storage requests and the store/coordinator APIs needed by manual force-sync and clear. Add or adjust focused tests to lock in the preserved manual and opened-session boundaries.
  **Files:**
  ./src/stores/SessionMessageCacheCoordinator.tsx - Remove automatic scheduling and global event-driven all-session history reconciliation while retaining any safe non-sync responsibility.
  ./src/stores/sessionMessageCacheCoordinator.ts - Preserve explicit force-sync and clear semantics; change only if needed to make automatic/manual boundaries explicit and testable.
  ./src/stores/sessionMessageCacheCoordinator.test.ts - Update focused policy coverage so manual synchronization remains intact and no required behavior depends on runtime automatic reconciliation.
  ./src/stores/useSessionStore.ts - Verify and preserve opened-session hydration, complete fetch persistence, realtime write-through, manual sync, clear, and persistence APIs; modify only where required by the boundary change.
  ./src/components/chat/hooks/useChatSessionState.ts - Verify ordinary opening still triggers complete network history and cache persistence; modify only if a focused boundary test or small explicit call is required.
  ./src/App.tsx - Keep authenticated provider mounting coherent if the coordinator component's responsibility changes.
  src/components/settings/view/tabs/CacheSettingsTab.tsx - Contextual consumer of manual force-sync and clear; behavior must remain functional and should not be refactored unnecessarily.
  package.json - Provides the validation commands for the changed frontend scope.
  **Acceptance criteria:** No manifest reconciliation or transcript download is triggered merely by app startup, elapsed time, focus/visibility/online activity, websocket reconnect, successful completion, or `session_upserted`; unopened historical sessions are not automatically added to IndexedDB. Opening a session still hydrates existing cache, fetches its complete authoritative history, and persists it; viewed-session refresh/recovery and realtime write-through remain intact. “Sync all histories,” cache statistics, clear, user scoping, serialization, stale-write protection, persistence requests, manifest safety, manual concurrency, and partial-failure reporting remain unchanged.
  **Validation:** Add/update focused tests that prove manual force-sync still includes all eligible histories and that the runtime mount does not schedule automatic reconciliation; retain tests for manual concurrency, malformed manifests, partial failures, and clear serialization. Run `node --import tsx --test src/stores/sessionMessageCacheCoordinator.test.ts` plus any new focused runtime/boundary test, `npm run typecheck:frontend`, targeted ESLint for touched source/tests, and `npm run build:client`.
  **Summary:** Reduced `SessionMessageCacheCoordinator.tsx` to its safe durable-storage request, removing startup, timer, browser-activity, websocket, completion, and `session_upserted` reconciliation triggers while leaving the authenticated mount coherent. Updated focused coordinator tests to assert the runtime mount cannot schedule manifest reconciliation and to preserve explicit force-sync coverage for all eligible active/archived histories, metadata-only rows, bounded manual concurrency, partial failures, malformed manifests, and clear serialization. Verified the existing opened-session complete fetch/persistence, refresh/recovery, realtime write-through, manual sync, clear, statistics, and persistence APIs required no changes.

- [x] **ID:** 2 | **Batch:** 1
  **Task:** Update Cache Settings wording in every registered locale to describe the new cache policy accurately: ordinary histories are cached when their sessions are opened, and all histories are cached only when the user explicitly invokes “Sync all histories.” Remove claims that histories may be recached automatically in the background while preserving all existing locale keys and UI structure.
  **Files:**
  ./src/i18n/locales/en/settings.json - Source cache wording must clearly state opened-session caching and explicit all-history synchronization.
  ./src/i18n/locales/de/settings.json - German cache wording must match the source behavior without changing key structure.
  ./src/i18n/locales/fr/settings.json - French cache wording must match the source behavior without changing key structure.
  ./src/i18n/locales/it/settings.json - Italian cache wording must match the source behavior without changing key structure.
  ./src/i18n/locales/ja/settings.json - Japanese cache wording must match the source behavior without changing key structure.
  ./src/i18n/locales/ko/settings.json - Korean cache wording must match the source behavior without changing key structure.
  ./src/i18n/locales/ru/settings.json - Russian cache wording must match the source behavior without changing key structure.
  ./src/i18n/locales/tr/settings.json - Turkish cache wording must match the source behavior without changing key structure.
  ./src/i18n/locales/zh-CN/settings.json - Simplified Chinese cache wording must match the source behavior without changing key structure.
  ./src/i18n/locales/zh-TW/settings.json - Traditional Chinese cache wording must match the source behavior without changing key structure.
  src/components/settings/view/tabs/CacheSettingsTab.tsx - Contextual UI that renders the locale copy; no component behavior change is expected.
  src/i18n/config.test.js - Existing locale-loading coverage is relevant to key/JSON integrity.
  package.json - Provides focused test and validation commands.
  **Acceptance criteria:** Cache Settings no longer says histories are automatically recached later; English and all nine other locales communicate that opening a session caches it and explicit “Sync all histories” caches all eligible histories. Existing cache keys remain present, all JSON parses, no raw i18n keys appear, and component behavior remains unchanged.
  **Validation:** Validate all `src/i18n/locales/*/settings.json` files parse and have matching `cache` key shapes; run `node --import tsx --test src/i18n/config.test.js`, targeted ESLint if any code/test file changes, and `npm run typecheck:frontend` or `npm run build:client` only if needed for the touched scope.
  **Summary:** Updated `cache.syncDescription`, `cache.clearSuccess`, and `cache.confirmationDescription` in all 10 registered `settings.json` locales to state that opening a session caches its history and the explicit “Sync all histories” action caches every available history. Preserved every locale key and left `CacheSettingsTab.tsx` behavior unchanged. Validated JSON/cache-key parity across all locales and passed the focused i18n config tests.

- [x] **ID:** 3 | **Batch:** 2
  **Task:** Make account-scoped deletion of an existing large session cache fast by replacing the current per-record cursor deletion in `SessionMessageCacheRepository.clearUserCache()` with direct compound-primary-key range deletion for both message and metadata stores. Preserve the coordinator/store clear lifecycle, including queued-write draining, write blocking and epoch fencing, atomic success/failure reporting, post-clear zero-stat verification, and other-user isolation.
  **Files:**
  ./src/stores/sessionMessageCache.ts - Replace the O(number of cached rows) cursor-delete loop with bounded account-key range deletes in one transaction.
  ./src/stores/sessionMessageCache.test.ts - Add large-cache and range-boundary tests proving prompt account clearing, idempotency, and preservation of lexically adjacent and unrelated namespaces.
  ./src/stores/sessionMessageCacheCoordinator.ts - Preserve the serialized clear and explicit `{ success, stats }` contract; change only if required for accurate fast-clear completion semantics.
  ./src/stores/sessionMessageCacheCoordinator.test.ts - Retain focused coverage for queued sync/write ordering, repository failures, non-zero post-clear stats, and successful zero-state reporting.
  ./src/stores/useSessionStore.ts - Preserve current-user scoping, wait-for-writes, cache-write blocking, and stale-write epoch protection around the repository clear.
  src/components/settings/view/tabs/CacheSettingsTab.tsx - Contextual clear UI that must resolve and close normally once the optimized transaction commits; no visual redesign is required.
  package.json - Provides focused frontend test, typecheck, lint, and build commands.
  **Acceptance criteria:** Clearing a cache with many thousands of message rows uses direct key-range deletion rather than opening a cursor and issuing one delete per row; both current-user object-store slices are deleted in one transaction; metadata-only sessions are removed; another user's rows, including namespaces with shared prefixes or lexically adjacent values, remain untouched; repeated clearing is safe; failures are still returned as unsuccessful; the Settings action resolves after transaction commit with zero stats and does not wait on work proportional to every cached message.
  **Validation:** Add focused fake-indexeddb tests with a large current-user dataset plus other-user/prefix-boundary rows, assert the optimized clear path does not use cursor-based row deletion, and verify zero stats, user preservation, metadata-only deletion, idempotency, and unavailable-storage fallbacks. Run `node --import tsx --test src/stores/sessionMessageCache.test.ts src/stores/sessionMessageCacheCoordinator.test.ts`, `npm run typecheck:frontend`, targeted ESLint for touched files, and `npm run build:client`.
  **Summary:** Replaced `clearUserCache()`'s two index-cursor/per-row loops with two compound-primary-key `IDBKeyRange` deletes issued in the existing shared readwrite transaction, preserving commit-based success/failure semantics and all coordinator/store/UI contracts without changes. Expanded `sessionMessageCache.test.ts` with a 5,000-message account, metadata-only data, prefix/lexical boundary namespaces, cursor-call instrumentation, preservation checks, and repeated-clear coverage; unavailable-storage and coordinator failure/zero-state tests remain passing. Focused tests, frontend typecheck, targeted ESLint, and client build all pass.

## CHANGELOG

- **Item 2:** Revised cache synchronization and post-clear wording in all 10 settings locales to describe cache-on-open and explicit all-history sync; locale JSON/cache-key parity and focused i18n tests pass.
- **Item 1:** Removed all runtime automatic all-session reconciliation from the mounted cache coordinator, retaining only the persistent-storage request; focused tests now enforce the no-scheduling boundary and preserved manual force-sync/concurrency/failure/clear contracts. Frontend tests, ESLint, typecheck, and client build pass.
- **Item 3:** Optimized account cache clearing to two bounded compound-primary-key range deletes in one transaction; added 5,000-row fake-indexeddb coverage proving no cursor deletion, metadata-only removal, idempotency, and prefix/adjacent/unrelated namespace preservation. Focused tests, ESLint, typecheck, and client build pass.
