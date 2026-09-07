# CONTEXT

CloudCLI is a TypeScript/React application with an Express-style backend under `server/`, a React/Vite frontend under `src/`, shared contracts under `shared/`, PWA assets under `public/`, and an Electron desktop companion under `electron/`. The requested deliverable is a set of concise but implementation-grounded Markdown code maps under `codemaps/`, with one delegated implementation task per major chapter and an `AGENTS.md` reading guide that points future agents to each map.

## Files

./package.json - Defines the application entry points, build modes, validation scripts, and backend/frontend test commands that orient every code map.
./server/index.ts - Bootstraps the backend application and registers its major modules and runtime infrastructure.
./server/modules/agent - Contains core agent and session-facing backend behavior.
./server/modules/providers - Contains provider discovery, model integration, and provider-specific backend behavior.
./server/modules/cli - Contains CLI execution, sandbox, and command-line entry behavior.
./server/modules/websocket - Contains real-time backend transport and event distribution.
./server/modules/projects - Contains project and workspace discovery APIs.
./server/modules/file-tree - Contains filesystem browsing and file operation services and routes.
./server/modules/git - Contains repository inspection and source-control operations.
./server/modules/worktrees - Contains worktree lifecycle APIs and services.
./server/modules/database - Contains database connection, schema, initialization, and migrations.
./server/modules/auth - Contains backend authentication middleware, services, routes, and module wiring.
./server/modules/settings - Contains persisted settings and Docker-management behavior.
./server/modules/appointments - Contains scheduled and queued agent work.
./server/modules/notifications - Contains push-notification routes and VAPID key management.
./server/modules/plugins - Contains plugin discovery, process management, registration, and APIs.
./server/modules/browser-use - Contains browser automation services, routes, and MCP integration.
./server/modules/commands - Contains command discovery and execution APIs.
./server/modules/voice - Contains voice processing services and routes.
./server/shared - Contains backend-wide types, interfaces, utility functions, and attachment handling.
./shared/cloudcli-contracts.ts - Defines contracts shared between frontend and backend.
./src/App.tsx - Defines the top-level frontend provider and application composition.
./src/components/app - Contains primary application orchestration and activity synchronization.
./src/components/sidebar - Contains project and session navigation UI.
./src/hooks/useProjectsState.ts - Coordinates frontend project and session selection state.
./src/stores/useSessionStore.ts - Implements the central session and message state store.
./src/stores/sessionMessageCache.ts - Implements browser-side session message caching.
./src/components/chat - Contains chat composition, message rendering, input, and tool-result UI.
./src/contexts/WebSocketContext.tsx - Owns frontend real-time connection lifecycle and message dispatch.
./src/components/file-tree - Contains the frontend file explorer.
./src/components/code-editor - Contains code viewing and editing UI.
./src/components/git-panel - Contains source-control UI and workflows.
./src/components/shell - Contains the integrated terminal and shell UI.
./src/components/browser-use - Contains browser-use frontend integration.
./src/components/settings - Contains settings surfaces and registrations.
./src/components/provider-auth - Contains provider authentication UI.
./src/components/plugins - Contains plugin-facing frontend UI and integration.
./src/components/skills - Contains skill discovery and management UI.
./src/components/onboarding - Contains first-run onboarding flows.
./src/lib/pwaRegistration.ts - Implements service-worker registration and update behavior.
./src/contexts/PwaUpdateContext.tsx - Exposes PWA update state to the frontend.
./src/hooks/useWebPush.ts - Implements browser push subscription behavior.
./public/manifest.json - Defines installable PWA metadata.
./public/sw.js - Implements service-worker caching, lifecycle, and notification handling.
./electron/main.js - Bootstraps and coordinates the desktop companion application.
./electron/desktopWindow.js - Implements desktop window lifecycle and navigation behavior.
./electron/localServer.js - Manages the local CloudCLI server from the desktop companion.
./electron/preload.cjs - Exposes the constrained desktop bridge to renderer content.
./AGENTS.md - Holds repository guidance and will gain one or two sentences explaining when to read each generated code map.

# ANALYSIS

The codebase has more than six genuinely major chapters, and forcing it into only three backend and three frontend documents would make the maps too broad to be useful. A practical decomposition is five backend maps, five frontend maps, one cross-cutting contracts map, and one desktop-platform map. This keeps each delegated task focused on a coherent subsystem while covering the dominant product flows named in the README and reflected in the top-level module structure.

The backend chapters should cover: application/API/auth foundations; agent/provider/CLI execution; realtime sessions and WebSocket event flow; workspace/filesystem/Git/worktree operations; and persistence/settings/automation/integrations. The frontend chapters should cover: application shell/navigation/project state; chat/session/message state and tool rendering; workspace tools such as files/editor/Git/terminal/browser; settings/provider authentication/plugins/skills/onboarding; and PWA/mobile update/push behavior. Shared frontend-backend contracts deserve a separate cross-cutting map because they define the system boundary, while Electron deserves a separate desktop map because it has its own process, window, local-server, and preload architecture.

Each chapter task must inspect implementation details independently and produce a navigational map rather than prose documentation: purpose and boundaries, primary entry points, important classes/types/functions/hooks/components, call or data flow, key files, extension points, and relevant tests or validation commands. Important symbol names must be verified from source; the Architect will not pre-read long implementation files. Generated maps must avoid copying large implementation excerpts and must explicitly distinguish confirmed behavior from inferred relationships.

All chapter-map tasks can run in one batch because they write disjoint Markdown files. A final dependent task should inspect all generated filenames and headings, then update `AGENTS.md` with a compact code-map index containing one or two sentences per map explaining when an agent should read it. No application source behavior should change, so validation is structural and documentation-focused rather than a full build or test run.

# PLAN

Create twelve implementation-grounded code maps in `codemaps/`: five backend chapters, five frontend chapters, one shared-contracts chapter, and one Electron desktop chapter. Delegate each chapter to a separate Code agent so detailed source reading remains distributed. After all maps exist, delegate a final documentation-index task to update `AGENTS.md` with concise guidance for every map and check the collection for structural consistency.

# GUIDELINES

- Write Markdown only under `codemaps/`, except for the final `AGENTS.md` index update and the assigned plan status/Summary/CHANGELOG edits.
- Each map must be useful for code navigation and include: scope and boundaries; major entry points; a categorized list of important classes, interfaces/types, functions, React components, hooks, stores, or services as appropriate; key runtime/data flow; important files; extension or change points; and focused tests/validation references.
- Use exact symbol names verified from source and pair each symbol with its defining path and a brief role. Do not invent class names in functional modules and do not omit important functions merely because a subsystem is function-oriented.
- Prefer concise tables, bullets, and Mermaid diagrams where they improve navigation. Avoid long copied source excerpts, exhaustive inventories of trivial helpers, or implementation tutorials.
- Cross-reference other maps for adjacent concerns rather than duplicating their full content.
- Read implementation files as needed within the assigned chapter; do not modify application code.
- Preserve the existing backend guidance in `AGENTS.md`. Its code-map index must mention every generated `.md` file in one or two concise sentences explaining when to read it.
- Validation is documentation-oriented: verify referenced paths exist, listed symbols are defined or exported where claimed, Markdown headings are coherent, and ownership does not substantially duplicate another map.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Create the backend foundations code map covering server bootstrap, HTTP/API composition, middleware, authentication, assets/static delivery, system/user endpoints, and backend-wide shared utilities.
  **Files:**
  ./server/index.ts - Primary backend bootstrap and module-registration entry point.
  ./server/modules/auth - Authentication middleware, services, routes, and module wiring.
  ./server/modules/assets - Static and asset-serving backend routes.
  ./server/modules/system - System information and health-related backend behavior.
  ./server/modules/user - User-facing backend services and routes.
  ./server/shared - Backend-wide interfaces, types, utilities, and attachment handling.
  ./codemaps/backend-foundations-api-auth.md - New code map for backend foundations.
  **Acceptance criteria:** The map identifies exact important classes/types/functions and explains startup, request handling, middleware/auth flow, module registration, shared infrastructure, and major extension points without drifting into subsystems owned by other maps.
  **Validation:** Confirm every named path exists and every highlighted symbol is defined in the cited source; review Markdown structure and cross-references.
  **Summary:** Created `codemaps/backend-foundations-api-auth.md` with verified navigation for backend startup/lifecycle, ordered Express middleware and route registration, JWT/API-key authentication, attachment assets, static/SPA delivery, system/user services, shared infrastructure, extension points, and focused tests. Validation confirmed cited paths/symbols by source inspection and passed 45 focused backend tests using `TSX_TSCONFIG_PATH=server/tsconfig.json`; the same direct command without that environment variable failed only because `@/` aliases were unresolved.

- [x] **ID:** 2 | **Batch:** 1
  **Task:** Create the backend agent execution code map covering agent routes, provider registry/integrations, CLI execution, sandbox behavior, and the lifecycle from an execution request to provider/CLI process handling.
  **Files:**
  ./server/modules/agent - Core backend agent and session execution routes.
  ./server/modules/providers - Provider registry, provider routes, and provider-specific integrations.
  ./server/modules/cli - CLI service, sandbox service, module wiring, and executable entry.
  ./codemaps/backend-agent-provider-cli.md - New code map for backend agent/provider/CLI execution.
  **Acceptance criteria:** The map names important services, route handlers, registries, interfaces, and functions; shows the main execution lifecycle and provider selection boundaries; and identifies safe extension points for providers and CLI behavior.
  **Validation:** Verify cited symbols and paths from source and check that major execution flows are represented without copying large implementation details.
  **Summary:** Created `codemaps/backend-agent-provider-cli.md`, mapping the external Agent HTTP lifecycle, provider registry/contracts/runtime and route boundaries, stable app/provider session and model selection, CLI dispatch, sandbox process flow, safe extension points, and focused tests. Verified cited symbols and paths directly against Agent, provider, CLI, shared-interface, server-composition, and realtime runtime-call sources; documentation-only validation passed with no application code changes.

- [x] **ID:** 3 | **Batch:** 1
  **Task:** Create the backend realtime sessions code map covering WebSocket server setup, connection/auth lifecycle, subscriptions, event routing, session updates, and interactions with agent execution.
  **Files:**
  ./server/modules/websocket - Backend real-time transport, handlers, event infrastructure, and subsystem README.
  ./server/modules/agent - Adjacent source for session and agent events emitted through the realtime layer.
  ./shared/cloudcli-contracts.ts - Shared event and payload contracts used across the transport boundary.
  ./codemaps/backend-realtime-websocket-sessions.md - New code map for backend real-time session behavior.
  **Acceptance criteria:** The map lists exact important symbols, explains connection establishment and event flow, identifies message/event categories and coupling points, and clearly scopes frontend behavior to cross-references.
  **Validation:** Verify important symbols and event names against source/contracts and ensure the flow diagram or equivalent narrative is internally consistent.
  **Summary:** Created `codemaps/backend-realtime-websocket-sessions.md` with verified gateway/auth/heartbeat, chat run lifecycle/registry/writer, subscription replay, protocol categories, session identity, agent-API boundary, coupling, extension points, and focused validation references. Checked highlighted symbols and `chat.*`/`kind` names against WebSocket source and shared contracts and walked the Mermaid flow against implementation. Unexpected: `SequencedChatEvent` requires `protocolVersion`, while current registry-decorated live events add only `generation` and `seq`; the map explicitly records this coordination point.

- [x] **ID:** 4 | **Batch:** 1
  **Task:** Create the backend workspace operations code map covering projects, file-tree services, Git routes/services, and worktree management as one filesystem and source-control chapter.
  **Files:**
  ./server/modules/projects - Project and workspace discovery routes.
  ./server/modules/file-tree - Filesystem traversal and file operation services/routes.
  ./server/modules/git - Git repository, parsing, and route behavior.
  ./server/modules/worktrees - Git worktree lifecycle behavior.
  ./codemaps/backend-workspaces-files-git.md - New code map for backend workspace operations.
  **Acceptance criteria:** The map identifies important route/service symbols, explains workspace path flow and safety boundaries, maps file and Git/worktree operations, and highlights where project identity connects these modules.
  **Validation:** Confirm paths and symbols, sample the major route groups for coverage, and check that security/path-validation responsibilities are accurately located.
  **Summary:** Created `codemaps/backend-workspaces-files-git.md` as a navigation-focused map of Projects, File Tree, Git, and Worktrees. It documents exact route/service symbols, authenticated mounts, project-ID-to-path flow, workspace/project/repository containment responsibilities, operation groups, project/worktree identity coupling, extension points, and focused tests. Validation sampled all four route groups and confirmed cited paths/symbols and security ownership against source; documentation-only change, so no runtime tests were required.

- [x] **ID:** 5 | **Batch:** 1
  **Task:** Create the backend persistence and integrations code map covering database/schema/migrations, settings, appointments, notifications, plugins, commands, browser-use, voice, and other automation/integration modules.
  **Files:**
  ./server/modules/database - Database schema, migrations, connection, and initialization.
  ./server/modules/settings - Settings persistence and Docker-management behavior.
  ./server/modules/appointments - Scheduled and queued work services and routes.
  ./server/modules/notifications - Push-notification and VAPID behavior.
  ./server/modules/plugins - Plugin registration, lifecycle, process management, and APIs.
  ./server/modules/commands - Command discovery and execution APIs.
  ./server/modules/browser-use - Browser automation and MCP-backed integration.
  ./server/modules/voice - Voice backend services and routes.
  ./codemaps/backend-persistence-automation-integrations.md - New code map for persistence and integration subsystems.
  **Acceptance criteria:** The map groups these modules coherently, names important exact symbols in each major area, explains persistence and lifecycle relationships, and gives future agents clear pointers for modifying one integration without reading unrelated modules.
  **Validation:** Verify source symbols and paths in every covered module and ensure no major listed module is represented only by a filename with no functional explanation.
  **Summary:** Created `codemaps/backend-persistence-automation-integrations.md`, grouping SQLite/schema/migrations, settings and notification persistence, appointment scheduling, plugins, commands, browser-use/MCP, and voice. The map names verified exact symbols and paths, traces durable versus process-local lifecycle relationships, provides integration-specific change pointers, and lists focused tests. Validation used path checks plus targeted source/export searches across every listed module; all criteria passed. Adjacent map filenames referenced for cross-navigation may be created by parallel TODOs.

- [x] **ID:** 6 | **Batch:** 1
  **Task:** Create the frontend application shell code map covering entry composition, providers, routing, main content, sidebar/navigation, project/session selection, command palette, and responsive shell structure.
  **Files:**
  ./src/main.tsx - Frontend bootstrap entry.
  ./src/App.tsx - Top-level application composition.
  ./src/appRoutes.tsx - Route definitions.
  ./src/components/app - Main application orchestration.
  ./src/components/main-content - Main content routing and layout.
  ./src/components/sidebar - Project/session navigation UI.
  ./src/components/command-palette - Global command palette UI.
  ./src/hooks/useProjectsState.ts - Primary project/session selection state hook.
  ./src/hooks/projectStateUtils.ts - Project-state helper logic.
  ./codemaps/frontend-app-shell-navigation.md - New code map for frontend shell and navigation.
  **Acceptance criteria:** The map names key components/hooks/functions and explains provider composition, route/layout flow, project/session selection, responsive navigation, and extension points for new top-level surfaces.
  **Validation:** Verify each highlighted symbol in source and trace at least the bootstrap-to-main-content and project-selection flows.
  **Summary:** Created `codemaps/frontend-app-shell-navigation.md` with verified provider, route/layout, responsive sidebar, command-palette, and project/session state symbols; documented bootstrap-to-main-content and URL/selection flows plus extension points. Validation: focused project-state tests passed (17/17), and cited symbols/paths were checked in source. Unexpected: `appRoutes` child elements are intentionally empty because `AppContentInner` consumes route matches directly rather than rendering an outlet.

- [x] **ID:** 7 | **Batch:** 1
  **Task:** Create the frontend chat and session-state code map covering the central session store, cache/reconciliation/history policy, chat UI, message rendering, input/queue behavior, and tool-result presentation.
  **Files:**
  ./src/stores/useSessionStore.ts - Central session and message state store.
  ./src/stores/sessionMessageCache.ts - Persistent browser-side message cache.
  ./src/stores/sessionMessageCacheCoordinator.ts - Cache coordination and hydration behavior.
  ./src/stores/sessionMessageReconciliation.ts - Message reconciliation logic.
  ./src/stores/sessionHistoryPolicy.ts - Session history retention/loading policy.
  ./src/components/chat - Chat, messages, inputs, and tool-result UI.
  ./src/hooks/useQueuedMessageAutoSend.ts - Queued-message dispatch behavior.
  ./src/utils/sessionHistoryValidation.ts - Session-history validation boundary.
  ./codemaps/frontend-chat-session-state.md - New code map for frontend chat and session state.
  **Acceptance criteria:** The map identifies important stores, actions, selectors, components, hooks, and helper functions; explains message lifecycle from load/send through realtime reconciliation and cache; and points to tool rendering extension areas.
  **Validation:** Verify exact symbol names, trace representative load/send/reconcile flows, and cite relevant focused tests.
  **Summary:** Created `codemaps/frontend-chat-session-state.md` with verified store actions/selectors, cache and manifest coordination, history policy/validation, chat/composer/realtime hooks, render components, representative load/send/reconcile/queue flows, and tool-rendering extension points. Validation passed with 63 focused frontend tests covering cache, coordinator, reconciliation, history, queue dispatch, message stabilization, and tool configs. Unexpected: the repository's frontend tests use Node's test runner rather than Vitest; the initial Vitest invocation executed assertions but reported every file as suite-less, so validation was rerun successfully with the package's `node --import tsx --test` convention.

- [x] **ID:** 8 | **Batch:** 1
  **Task:** Create the frontend workspace tools code map covering file explorer, code editor, Git panel, integrated shell/terminal, browser-use UI, and how these tools coordinate with project state and backend APIs.
  **Files:**
  ./src/components/file-tree - Frontend file explorer and operations.
  ./src/components/code-editor - Code viewing/editing and recovery UI.
  ./src/components/git-panel - Git status, diff, staging, commit, and branch UI.
  ./src/components/shell - Integrated terminal and shell components.
  ./src/components/standalone-shell - Standalone shell route/surface.
  ./src/components/browser-use - Browser-use frontend integration.
  ./src/hooks/useFileOpenResolver.ts - File-open resolution logic.
  ./src/stores/editorRecoveryStore.ts - Editor recovery state.
  ./src/utils/api.ts - Frontend API functions used by workspace tools.
  ./codemaps/frontend-workspace-tools.md - New code map for frontend workspace tools.
  **Acceptance criteria:** The map lists exact important components/hooks/functions/stores, explains the main file-open/edit/save, Git, terminal, and browser-use flows, and highlights shared project/API dependencies without duplicating shell or state maps.
  **Validation:** Verify symbol/path accuracy and trace one representative flow for each major tool category.
  **Summary:** Created `codemaps/frontend-workspace-tools.md` with exact file explorer, editor/recovery, Git, shell/standalone-shell, and Browser symbols; documented project/API boundaries, extension points, focused tests, and representative file-open/save, Git stage/commit, terminal WebSocket, and Browser monitor traces. Validation was documentation-oriented: cited paths/exports and endpoint call sites were checked against source; no application code or other maps changed.

- [x] **ID:** 9 | **Batch:** 1
  **Task:** Create the frontend configuration and extensibility code map covering settings, quick settings, provider authentication, plugins, MCP, skills, onboarding, project creation, and related registration/context patterns.
  **Files:**
  ./src/components/settings - Settings UI and settings-section registrations.
  ./src/components/quick-settings-panel - Quick-access settings UI.
  ./src/components/provider-auth - Provider authentication UI.
  ./src/components/plugins - Plugin-facing frontend integration.
  ./src/contexts/PluginsContext.tsx - Plugin state and lifecycle context.
  ./src/components/mcp - MCP configuration UI and types.
  ./src/components/skills - Skill discovery and management UI.
  ./src/components/onboarding - First-run onboarding flow.
  ./src/components/project-creation-wizard - New-project workflow.
  ./src/hooks/useUiPreferences.ts - UI preference state and persistence.
  ./codemaps/frontend-settings-plugins-onboarding.md - New code map for configuration and extensibility UI.
  **Acceptance criteria:** The map identifies registration mechanisms and exact important symbols, explains how configuration surfaces are composed and persisted, and distinguishes provider, plugin, MCP, skill, onboarding, and project-creation responsibilities.
  **Validation:** Verify highlighted symbols and trace the settings registration/composition pattern plus at least one provider/plugin lifecycle flow.
  **Summary:** Created `codemaps/frontend-settings-plugins-onboarding.md` with verified settings registration/composition points, persistence behavior, exact symbols, provider and plugin lifecycle traces, and distinct MCP, skill, onboarding, and project-creation ownership. Validation passed through direct symbol/flow checks and the repository deterministic suite: client/server builds, typecheck, lint, 427 frontend tests, 475 backend tests, 9 shared-contract tests, PWA validators, and 12 browser stability tests. No application code or other maps were changed; the registration lists currently have a documented `voice` inconsistency.

- [x] **ID:** 10 | **Batch:** 1
  **Task:** Create the PWA code map covering manifest/installability, service-worker registration and lifecycle, update UX, cache behavior, web push notifications, mobile-specific behavior, and PWA validation/build integration.
  **Files:**
  ./public/manifest.json - PWA installation metadata.
  ./public/sw.js - Service-worker caching, lifecycle, and notification implementation.
  ./src/lib/pwaRegistration.ts - Frontend service-worker registration and update handling.
  ./src/contexts/PwaUpdateContext.tsx - PWA update state exposed to UI.
  ./src/hooks/useWebPush.ts - Browser push-subscription behavior.
  ./src/hooks/useDeviceSettings.ts - Device-specific settings behavior.
  ./vite.config.js - PWA asset/build integration.
  ./scripts/validation - PWA and service-worker validation scripts.
  ./e2e - Browser-level PWA validation coverage.
  ./codemaps/frontend-pwa-mobile-push.md - New code map dedicated to PWA/mobile/push architecture.
  **Acceptance criteria:** The map names exact functions/hooks/components/events, explains install/register/update/cache/push lifecycles, identifies mobile-specific touchpoints, and lists relevant validation commands from `package.json`.
  **Validation:** Verify symbols and service-worker event names, confirm script names, and ensure install/update/push flows are separately understandable.
  **Summary:** Created `codemaps/frontend-pwa-mobile-push.md` with verified entry points, exact registration/update/cache/push/mobile symbols and service-worker events, separately traced install/registration, update/reload, offline-cache, and push-navigation lifecycles, build injection and extension points, and package-script/browser validation references. Validation passed: focused PWA registration/web-push tests (7), service-worker lifecycle (7), notification (3), install metadata (2), asset validation, plus direct symbol/event and package-script checks. No application code was changed.

- [x] **ID:** 11 | **Batch:** 1
  **Task:** Create the cross-cutting contracts and client transport code map covering shared API/event contracts, frontend API client/auth token handling, server-state discovery, and the typed boundaries joining backend, frontend, and realtime layers.
  **Files:**
  ./shared/cloudcli-contracts.ts - Shared frontend/backend contracts.
  ./shared/cloudcli-contracts.test.ts - Contract validation tests.
  ./src/utils/apiClient.ts - Generic frontend HTTP client and error behavior.
  ./src/utils/api.ts - Feature-level frontend API wrappers.
  ./src/utils/authToken.ts - Frontend auth-token acquisition and persistence.
  ./src/lib/serverState.ts - Frontend server-state discovery and normalization.
  ./src/contexts/webSocketTypes.ts - Frontend realtime transport types.
  ./src/contexts/webSocketTransport.ts - Frontend realtime transport helpers.
  ./codemaps/shared-contracts-api-transport.md - New code map for cross-layer contracts and transport.
  **Acceptance criteria:** The map names important types/functions, shows HTTP and WebSocket boundaries, explains auth and server-state participation, and identifies where contract changes must be coordinated across layers.
  **Validation:** Verify exact exports and their consumers, cite contract/client tests, and check that cross-references point to the more detailed backend realtime and frontend state maps.
  **Summary:** Added `codemaps/shared-contracts-api-transport.md`, mapping verified shared contract exports/parsers, typed and compatibility HTTP layers, auth-token lifecycle, `KeyedServerState`, frontend WebSocket types/helpers and their concrete consumers, coordination points, cross-references, and focused tests. Validation passed: `npm run test:contracts` (9/9) and focused API client/auth token/server state/WebSocket transport tests (29/29). The detailed realtime/frontend state maps were not yet present during this batch, so links use their planned relative filenames.

- [x] **ID:** 12 | **Batch:** 1
  **Task:** Create the Electron desktop code map covering main-process bootstrap, desktop windows/tabs/views, local-server management, notifications, preload bridge, launcher behavior, and packaging/runtime boundaries.
  **Files:**
  ./electron/main.js - Desktop main-process bootstrap and orchestration.
  ./electron/desktopWindow.js - Window lifecycle and desktop UI behavior.
  ./electron/viewHost.js - Hosted web-content view behavior.
  ./electron/tabs.js - Desktop tab state and helpers.
  ./electron/localServer.js - Local CloudCLI server management.
  ./electron/serverInstaller.js - Server installation/update behavior.
  ./electron/desktopNotifications.js - Native notification behavior.
  ./electron/preload.cjs - Renderer bridge exposure.
  ./electron/launcher - Desktop launcher implementation.
  ./codemaps/desktop-electron-companion.md - New code map for the Electron companion.
  **Acceptance criteria:** The map identifies exact important classes/functions/objects, explains process and window/view relationships, local-server startup, preload security boundary, notifications, and packaging/launch extension points.
  **Validation:** Verify symbols and paths from source and trace remote-workspace and local-server startup paths at a navigational level.
  **Summary:** Created `codemaps/desktop-electron-companion.md` covering verified main-process controllers, BrowserWindow/BrowserView/tab relationships, local-server installation and startup, remote workspace launch, preload/IPC security, notifications, launcher behavior, packaging, and extension points. Validation traced local and remote startup paths, confirmed cited paths/symbols, found no Electron-focused tests, and passed `node --check` for all mapped JavaScript/CJS files.

- [x] **ID:** 13 | **Batch:** 2
  **Task:** Add an `AGENTS.md` code-map index with one or two concise sentences per generated map explaining when to read it, and perform a consistency pass across all maps.
  **Files:**
  ./AGENTS.md - Repository guidance to extend with the complete code-map reading index.
  ./codemaps - Generated code-map collection to inspect for filenames, headings, links, and scope consistency.
  **Acceptance criteria:** `AGENTS.md` retains existing guidance and mentions every map by exact relative path with actionable reading guidance; all map files have clear titles, no broken relative path references, and no obvious empty required sections or major ownership conflicts.
  **Validation:** Enumerate `codemaps/*.md`, compare one-to-one against `AGENTS.md`, inspect Markdown links/paths, and report any corrected inconsistencies.
  **Summary:** Extended `AGENTS.md` without altering its backend guidance, adding actionable reading guidance for all twelve exact `codemaps/*.md` paths. Enumerated the map collection one-to-one against the index and inspected titles, Markdown links, map cross-references, required navigational content, and ownership boundaries; validation found no broken links, missing maps, empty required content, or major scope conflicts, so no generated map corrections were needed.

# CHANGELOG
- 2026-08-12 — TODO 6: Added the frontend application shell/navigation code map; verified bootstrap and selection traces and passed 17 focused project-state tests.

- **TODO 12:** Added the Electron desktop companion code map, verified its cited symbols and local/remote startup traces against source, and syntax-checked all mapped Electron JavaScript/CJS files successfully.
- 2026-08-12 — TODO 10: Added the dedicated frontend PWA/mobile/web-push code map and verified its symbols, worker events, package scripts, and focused lifecycle/subscription validations.
- 2026-08-12 — TODO 11: Added the shared contracts/API/transport code map; verified exports and cross-layer consumers, and passed 9 contract plus 29 focused client transport/state tests.
- 2026-08-12 — TODO 5: Created and source-verified `codemaps/backend-persistence-automation-integrations.md`, covering all assigned persistence, automation, and integration modules with lifecycle and targeted change guidance.
- 2026-08-12 — TODO 4: Added `codemaps/backend-workspaces-files-git.md`; verified Projects, File Tree, Git, and Worktrees mounts/routes, exact major symbols, project identity flow, and workspace/path safety boundaries against implementation source.

- **TODO 2:** Added `codemaps/backend-agent-provider-cli.md` with verified Agent execution, provider selection/contracts/routes, CLI/sandbox lifecycle, extension points, and focused validation references; source/path verification passed.
- 2026-08-12 — TODO 7: Added the frontend chat/session-state code map; verified load, send, sequenced realtime reconciliation, durable cache, queue, and tool-rendering paths and passed 63 focused tests.
- 2026-08-12 — TODO 8: Added the frontend workspace-tools code map; verified cited symbols/paths and traced file/editor, Git, terminal, and Browser flows from UI through API or WebSocket boundaries.

- 2026-08-12 — TODO 1: Added the backend foundations/API/auth code map; verified referenced source symbols and passed 45 focused backend tests with the server TypeScript path configuration.
- 2026-08-12 — TODO 3: Added the backend realtime/WebSocket/session-run code map; verified exact symbols, command/event names, replay flow, and the shared-contract protocol-version coordination point.
- 2026-08-12 — TODO 9: Added the frontend settings/plugins/onboarding code map; verified registration, provider authentication, and plugin mutation/runtime flows, with all deterministic validation checks passing.
- 2026-08-12 — TODO 13: Added the complete twelve-map reading index to `AGENTS.md`; one-to-one filename, title, relative-link, required-content, and ownership checks passed with no map corrections required.
