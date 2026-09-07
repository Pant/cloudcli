# Frontend PWA, Mobile, and Web Push

## Scope and boundaries

This map covers install metadata, production service-worker registration, offline caching, browser push subscriptions/notifications, and the mobile/PWA runtime signals consumed by the frontend. Backend notification generation and persisted notification settings live under `server/modules/notifications` and `server/modules/settings`; general responsive application layout belongs in `frontend-app-shell-navigation.md`.

## Primary entry points

| Entry point | Role |
| --- | --- |
| `public/manifest.json` | Relative-scope install metadata (`id`, `start_url`, and `scope` are `./`), standalone display, ordinary/maskable icons, and wide/narrow screenshots. |
| `initializePwaRegistration` — `src/lib/pwaRegistration.ts` | Called from `src/main.tsx`; starts the single browser registration initialization. |
| `useWebPush` — `src/hooks/useWebPush.ts` | Used by `Settings`; presents permission/subscription/loading state and subscribe/unsubscribe actions. |
| `useDeviceSettings` — `src/hooks/useDeviceSettings.ts` | Supplies `isMobile` and `isPWA` to responsive/PWA-aware UI. |
| `public/sw.js` | Implements the `install`, `activate`, `fetch`, `push`, and `notificationclick` service-worker events. |

## Important symbols

### Registration

| Symbol | Path | Responsibility |
| --- | --- | --- |
| `getPwaBaseUrl` | `src/lib/pwaRegistration.ts` | Resolves the PWA root from deployment-base manifest metadata (or an explicit manifest URL), preserving root/subpath deployments without inheriting nested routes. |
| `createPwaRegistrationController` | `src/lib/pwaRegistration.ts` | In production, registers `sw.js` after `window.load` with the manifest-derived scope and `updateViaCache: 'none'`; in development, unregisters CloudCLI `sw.js` registrations. |
| `initializePwaRegistration` | `src/lib/pwaRegistration.ts` | Memoizes registration startup and no-ops when service workers are unsupported. |

### Cache and worker helpers

| Symbol/event | Path | Responsibility |
| --- | --- | --- |
| `BUILD_ID`, `SHELL_FILES`, `SHELL_CACHE`, `RUNTIME_CACHE` | `public/sw.js` | Build-injected cache identity and generated application-shell graph. |
| `scopedUrl`, `isCloudCliCache`, `isEligibleResponse`, `isApiPath` | `public/sw.js` | Scope-safe URL construction and cache/interception guards. |
| `trimRuntimeCache` | `public/sw.js` | Limits the runtime cache to `RUNTIME_LIMIT` (80) entries. |
| `install` | `public/sw.js` | Precaches all generated shell files; deliberately does not call `skipWaiting`. |
| `activate` | `public/sw.js` | Removes obsolete caches with the `cloudcli-pwa-` prefix, preserves current and foreign caches, then claims clients. |
| `fetch` | `public/sw.js` | Excludes cross-origin, non-GET, and API requests; uses network-first shell fallback for navigation, cache-first generated shell assets, and network-first runtime caching for other scoped resources. |

### Push and mobile touchpoints

| Symbol/event | Path | Responsibility |
| --- | --- | --- |
| `urlBase64ToUint8Array` | `src/hooks/useWebPush.ts` | Converts the URL-safe VAPID public key into subscription bytes. |
| `ensureWebPushSubscription` | `src/hooks/useWebPush.ts` | Fetches the VAPID key, reconciles/replaces stale browser subscriptions, and POSTs the resulting endpoint/keys to `/api/settings/push/subscribe`. |
| `removeWebPushSubscription` | `src/hooks/useWebPush.ts` | Unsubscribes locally and POSTs the endpoint to `/api/settings/push/unsubscribe`. |
| `useWebPush` | `src/hooks/useWebPush.ts` | Requests notification permission, waits for `navigator.serviceWorker.ready`, reconciles granted subscriptions, and disables web push when unsupported or the Electron desktop bridge is present. |
| `push` | `public/sw.js` | Parses JSON/text payloads and calls `showNotification`; OpenCode completion payloads can vibrate, and eligible completed runs add a `reply` action. |
| `notificationclick` | `public/sw.js` | Focuses a scoped client and posts `notification:navigate`, or opens a scope-relative session URL; reply actions add `notificationReply=1`. |
| `useDeviceSettings` | `src/hooks/useDeviceSettings.ts` | Tracks mobile width (default breakpoint `768`) and installed/standalone state. PWA detection checks `(display-mode: standalone)`, iOS `navigator.standalone`, and Android app referrers. |

Mobile consumers include `AppContentInner` (`src/components/app/AppContent.tsx`) for project/navigation behavior, `QuickSettingsPanelTrigger` for mobile presentation, and `Sidebar` for installed-PWA-aware UI. `manifest.json` supplies a narrow mobile screenshot and maskable icons but intentionally does not force orientation.

## Separate runtime lifecycles

### Install and registration

1. Vite expands the `%BASE_URL%manifest.json` link to the deployment root/subpath, so root and deep-link documents resolve the same install metadata before JavaScript runs.
2. `src/main.tsx` calls `initializePwaRegistration()` before React renders.
3. Production registration waits for `window.load`, derives the base with `getPwaBaseUrl`, and registers the scoped `sw.js`; development removes matching workers to avoid stale-cache interference.
4. Vite's `cloudcli-client-build-id` plugin emits `cloudcli-version.json`, then during `closeBundle` discovers the finalized JS/CSS files directly from the cleaned `dist/assets/` output. It combines those deterministic, sorted paths with `index.html`, `manifest.json`, and the version file before replacing `__CLOUDCLI_BUILD_ID__` and `__CLOUDCLI_SHELL__` in `dist/sw.js`.
5. The server serves generated `dist/` output before source `public/` files, so root `sw.js` requests receive the placeholder-free built worker whenever it exists. Its stale-client bridge applies the same `dist/sw.js`-first rule to nested worker requests while retaining source-only fallback; arbitrary nested extension requests remain 404.

### Cache and offline requests

1. `install` precaches the generated scoped shell into the build-specific shell cache.
2. `activate` deletes only old CloudCLI cache generations and claims pages.
3. Navigations try the network and fall back to cached `index.html`, enabling deep-link shell startup offline.
4. Generated shell resources are cache-first. Other eligible in-scope GET resources are network-first, written to the bounded runtime cache, and fall back to cache or a `503` response. API calls and mutations are never intercepted.

### Push subscription and notification navigation

1. `Settings` calls `useWebPush`; enabling invokes `Notification.requestPermission()` and waits for the active registration.
2. `ensureWebPushSubscription` gets `/api/settings/push/vapid-public-key`, replaces a subscription whose application-server key is stale, subscribes with `userVisibleOnly: true`, and registers it with the backend. Granted permission also triggers reconciliation on hook mount.
3. Disabling uses `removeWebPushSubscription`, then re-reads `pushManager.getSubscription()` to update UI state. `Settings` mirrors successful backend channel changes into local notification preferences.
4. A `push` event displays the payload. On `notificationclick`, the worker focuses/posts `notification:navigate` to an existing scoped window or opens the session URL. `AppContentInner` handles that message by selecting the provider/chat surface, refreshing projects, navigating to the session, and forwarding reply intent when requested.

## Change and extension points

- Install branding, icon purposes/sizes, screenshots, display mode: `public/manifest.json` and generated assets under `public/`.
- Shell membership/build identity injection: the `cloudcli-client-build-id` plugin in `vite.config.js`; keep worker placeholders, built-output validation, and the server's built-first root/nested worker delivery synchronized.
- Offline policy or cache limits: `public/sw.js`; preserve API/mutation exclusions, subpath scoping, and foreign-cache ownership.
- Push payload presentation/actions: `public/sw.js`; subscription endpoints and VAPID reconciliation: `useWebPush.ts` plus the backend notification/settings modules.
- Mobile/PWA detection: `useDeviceSettings.ts`; consumers can disable unnecessary listeners with `trackMobile` or `trackPWA`.

## Tests and validation

Relevant `package.json` commands:

- `npm run validate:pwa` — aggregate asset, worker notification/lifecycle, install metadata, font, and built-output validation.
- `npm run validate:pwa-assets` — validates manifest URLs, branding, icon purposes, physical dimensions/types, and screenshots.
- `npm run validate:service-worker-lifecycle` — exercises `install`, `activate`, `fetch`, and `notificationclick` behavior and asserts update-only worker messages are absent.
- `npm run validate:service-worker-notifications` — checks `push` completion vibration/action behavior and rich-option fallback.
- `npm run test:pwa-install-metadata` — checks manifest link/branding and install assets.
- `npm run validate:pwa-built-output` — requires a built `dist/`; checks replaced worker placeholders, required metadata, deterministic shell categories, HTML entry-script membership, and that every shell path is an existing finalized output file.
- `npm run build:client` — creates the production client/worker output and runs client bundle checks.
- `npm run test:e2e:pwa` — runs the Playwright `production-pwa` project, including built registration/cache/offline coverage in `e2e/pwa.spec.ts` (and project-selected PWA specs).
- `npm run test:frontend -- --test-name-pattern='PWA|push|service worker'` is useful for focused symbol-level tests; direct files are `src/lib/pwaRegistration.test.ts` and `src/hooks/useWebPush.test.ts`.

Additional browser coverage in `e2e/offline-pwa.spec.ts` verifies cold offline navigation, retained local drafts/queues, notification reply deep links, and offline recovery.
