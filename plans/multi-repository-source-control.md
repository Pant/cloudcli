# CONTEXT

## Files

./server/modules/git/git.routes.ts - Defines every Source Control Git endpoint and currently resolves all commands to the selected project's workspace path.
./server/modules/git/git.module.ts - Composes the Git router with filesystem, subprocess, project-path, and provider dependencies.
./server/modules/git/tests/git-init.routes.test.ts - Existing Git route harness covering repository validation and initialization behavior.
./server/modules/git/tests/git.test.ts - Existing focused Git parsing tests and the natural location for pure Git helper coverage only.
./server/shared/utils.ts - Shared backend utility home required if repository-path containment logic is consumed by both Git and Worktrees modules.
./server/modules/worktrees/worktrees.routes.ts - Parses Worktrees requests and currently resolves only the selected project's workspace path.
./server/modules/worktrees/worktrees.module.ts - Composes Worktrees services and owns project-path resolution for every worktree operation.
./server/modules/worktrees/tests/worktrees.routes.test.ts - Existing route tests for Worktrees request parsing and service delegation.
./src/components/git-panel/types/types.ts - Frontend Source Control contracts for repository state, controller options, and API payloads.
./src/components/git-panel/hooks/useGitPanelController.ts - Owns Source Control API calls and repository-scoped state, currently keyed only by project ID.
./src/components/git-panel/view/GitPanel.tsx - Top-level Source Control screen that coordinates header, tabs, repository errors, and file opening.
./src/components/git-panel/view/GitPanelHeader.tsx - Header UI where repository selection can sit alongside branch and remote controls.
./src/components/git-panel/hooks/useRevertLocalCommit.ts - Separate Git mutation hook that must target the active repository rather than always the workspace path.
./src/components/git-panel/hooks/useWorktreesController.ts - Worktrees API client that must forward the active repository selection.
./src/components/git-panel/view/worktrees/WorktreesView.tsx - Worktrees tab boundary that must receive and retain the active repository context.
./src/components/git-panel/view/changes/ChangesView.tsx - Uses a path key for commit-message caching and must distinguish different repositories inside one workspace.
src/components/main-content/view/MainContent.tsx - Mounts the Source Control screen with the selected project and editor file-open callback.
server/modules/git/git-parsing.service.ts - Existing Git output parser remains the source for status and log parsing behavior.
server/modules/worktrees/services/worktree-list.service.ts - Lists worktrees from whichever repository path the Worktrees route resolves.
package.json - Defines Node test, typecheck, lint, and build commands used for validation.
AGENTS.md - Requires backend changes to follow the repository's backend module standards skill.
.agents/skills/backend-module-standards/SKILL.md - Specifies thin routes, shared-definition placement, module boundaries, tests, and validation for backend work.

# ANALYSIS

The screen currently assumes one Git context per selected CloudCLI project: every frontend request sends only the database project ID, and every backend Git route converts that ID directly to the workspace root path. This works when the workspace root is itself a repository or lies inside one repository, but it cannot enumerate or explicitly target independent repositories nested beneath the workspace.

The feature needs two related capabilities. First, the backend must discover Git work trees below the selected workspace, including the workspace root when applicable, and return stable workspace-relative repository identifiers suitable for UI selection. Discovery should recognize both `.git` directories and `.git` files (submodules/worktrees), avoid traversing Git metadata or following directory symlinks, deduplicate canonical repository roots, and return deterministic ordering with the workspace root first. Second, every operation initiated by the Source Control screen must accept an optional repository identifier and resolve it safely beneath the selected workspace before running Git. Keeping the identifier workspace-relative preserves portability and prevents exposing arbitrary absolute paths; omitting it must continue to mean the workspace path so command-palette and legacy callers remain compatible.

Repository resolution is security-sensitive. A shared backend helper should normalize the relative selector, reject absolute paths, NUL bytes, and traversal outside the workspace, and optionally confirm the selected path is a discovered/valid repository before destructive or mutating operations. The same containment semantics are needed by the Git and Worktrees modules, so they belong in the shared backend utility surface with the required documentation and grouping conventions. Git discovery and Git-command orchestration should live in a Git service rather than adding more filesystem/business logic to the already-large route file; touched route code should remain focused on parsing the optional selector and delegating resolution.

On the frontend, the controller should load repositories per project, select the root repository when present and otherwise the first discovered nested repository, preserve a valid selection across refreshes, and reset all Git state whenever either project or repository changes. All Git query/body requests from this screen, including diff, staging, commit, branch, remote, initialization, and revert, must carry the active repository selector. The header should expose an accessible repository dropdown showing concise workspace-relative labels and a refresh path should rediscover repositories. If no repository exists, the existing initialization state should remain available for the workspace root; after initialization, discovery should rerun and select it.

Git reports file paths relative to the active repository, while CloudCLI's editor callback expects paths relative to the selected workspace. For a nested repository, file API calls must continue using repository-relative paths, but opening a file in the editor must prefix the repository's workspace-relative directory. Commit-message draft caching must likewise use a repository-specific key so drafts from two repositories in one workspace do not collide.

The Worktrees tab is part of the Source Control screen and must operate on the same selected repository. Its frontend requests therefore need the repository selector, and its backend route/module resolution must apply the same safe workspace-relative path resolution before invoking existing worktree services. Existing callers that omit the selector should retain current behavior.

No product clarification is blocking: a repository dropdown with deterministic automatic selection is the least disruptive interpretation of “work on a per git repo level,” and backward-compatible optional API parameters protect non-panel Git consumers. Validation should emphasize route/service tests for discovery, containment, selector forwarding, root fallback, and nested targeting, followed by frontend/server typechecking and scoped lint/build checks.

Post-implementation investigation reproduced the remaining failure in the actual workspace layout: `/home/dev/code` is not a valid Git work tree but contains an empty `.git` directory, while `cloudcli-src` is a valid child repository. `GitRepositoryService.discover()` currently treats the mere presence of any `.git` file/directory as authoritative, reports `.` first, and the frontend correctly auto-selects that false-positive root; Git status then fails and masks the usable child repository. Resolution has the same marker-only weakness. Repository candidates must be verified by Git itself and must resolve to the candidate directory as their work-tree root, while retaining marker-based traversal as the inexpensive candidate-discovery mechanism.

The second live report exposed a frontend orchestration race independent of repository qualification. On project mount, one effect clears `activeRepository` and starts discovery, while another immediately requests `/api/git/status` with no repository selector. The root status responds first with `notGitRepository`, rendering the initialize prompt; discovery can later select `cloudcli-src`, but stale-root protection is only ref-updated in a passive effect, so response ordering can still commit the wrong state or leave the panel presenting root initialization during discovery/failure. Repository discovery must gate repository-scoped Git loading, atomically establish the active scope before requests, and surface discovery failures instead of treating them as “no repositories.”

Live browser validation after the race fix showed discovery itself taking about 108 seconds for `/home/dev/code`. The service recursively awaits every directory and scans generated/vendor trees such as `node_modules`, caches, build outputs, and provider runtime data before returning the already-known top-level `cloudcli-src` repository. The panel therefore appears empty or unchanged long enough to be perceived as broken. Discovery needs bounded concurrency and conservative directory pruning while retaining nested application repositories, deterministic output, `.git` file support, symlink safety, and authoritative Git-root qualification.

The latest report confirms that repository selection is still not discoverable in the UI. The only selector is embedded inside `GitPanelHeader`, and that entire header is rendered only after `activeRepository` exists. During repository discovery the panel shows ordinary Changes/Commits tabs and an empty changes state with no repository control, label, progress, or explanation; under live load discovery can still take long enough that users never see the conditional selector and reasonably conclude it does not exist. Repository choice must be a permanent, first-class row in the Source Control screen, visible while loading, after success, on empty results, and on errors, rather than being conditional on a selected repository or visually conflated with branch actions.

# PLAN

1. Add a backend repository-discovery and safe workspace-relative resolution contract, expose discovery through the Git API, and apply the optional `repository` selector to all Git and Worktrees operations while preserving workspace-root behavior for omitted selectors.
2. Make the Source Control client repository-aware: discover/select repositories, provide a repository picker, scope every operation and state reset to the active repository, translate repository-relative file paths for the workspace editor, and keep Worktrees on the same repository.
3. Correct repository qualification so malformed or incidental `.git` markers cannot be selected ahead of valid nested repositories, and lock the real non-Git-workspace/child-repository case down with focused tests.
4. Remove the frontend discovery/status race so Source Control waits for repository discovery before requesting status, reliably activates the first nested repository, and never converts discovery errors or transient root requests into the initialize-repository state.
5. Make recursive repository discovery fast enough for real workspace roots by pruning generated/vendor metadata and traversing eligible directories with bounded concurrency.
6. Expose repository selection as a persistent, clearly labeled Source Control control that remains visible throughout discovery and repository state transitions.

# GUIDELINES

- Follow ./.agents/skills/backend-module-standards/SKILL.md for every change under `server/`: keep routes limited to transport parsing/delegation, put filesystem/subprocess orchestration in services, use shared definitions only when consumed in multiple files, and keep cross-module imports on public barrels.
- Use `repository` as the optional HTTP query/body field containing a normalized workspace-relative repository path; represent the workspace root as `.` and retain current workspace-path behavior when the field is omitted.
- Never accept an absolute repository selector or allow `..`, symlink, or separator tricks to escape the selected project's workspace; backend resolution is authoritative even if the UI supplies a known option.
- Discovery must include the workspace root when it is a work tree, recognize `.git` directories and `.git` files, skip Git metadata and directory symlinks, deduplicate resolved repository roots, and return deterministic root-first/path-sorted results.
- Existing command-palette and other Git API consumers that send only `project` must continue to work unchanged.
- Frontend Git API calls use repository-relative file paths; only the editor callback receives paths prefixed by the selected repository's workspace-relative path.
- Repository changes are equivalent to project changes for stale-response protection and state reset; do not let status, branches, commits, diffs, remote state, operation errors, or commit drafts leak between repositories.
- Keep labels concise and accessible: show the project folder/root as the root repository and nested repositories by workspace-relative path, with a clear repository selector near the branch controls.
- Avoid unrelated refactors in the large legacy Git route/controller files and keep validation scoped to affected modules before running broader type/lint checks.

# TODO


- [x] **ID:** 1 | **Batch:** 1
  **Task:** Implement backend discovery and secure per-repository targeting for all Source Control Git and Worktrees endpoints, with backward-compatible root fallback.
  **Files:**
  ./server/modules/git/git.routes.ts - Parse the optional repository selector, expose repository discovery, and delegate every Git operation to a safely resolved repository path.
  ./server/modules/git/git.module.ts - Compose any new repository-discovery/resolution service dependencies required by the Git router.
  ./server/modules/git/tests/git-init.routes.test.ts - Extend the Git route harness to verify discovery, root fallback, nested targeting, invalid selector rejection, and init behavior.
  ./server/modules/git/tests/git.test.ts - Add pure helper tests only if repository discovery/resolution exposes parsing logic appropriate for this suite.
  ./server/shared/utils.ts - Add documented reusable workspace-relative path containment/resolution utilities shared by Git and Worktrees.
  ./server/shared/types.ts - Update shared Worktrees contracts or add genuinely shared repository contracts required by multiple backend files.
  ./server/modules/worktrees/worktrees.routes.ts - Parse and forward the optional repository selector for list/create/open/merge/remove requests.
  ./server/modules/worktrees/worktrees.module.ts - Resolve the selected nested repository safely before invoking existing Worktrees services.
  ./server/modules/worktrees/tests/worktrees.routes.test.ts - Verify repository selector parsing/forwarding and unchanged behavior when omitted.
  server/modules/git/git-parsing.service.ts - Existing status/log parsing behavior must remain compatible and should only change if necessary.
  server/modules/worktrees/services/worktree-list.service.ts - Existing service consumes the resolved repository path and is contextual unless a compatibility adjustment is required.
  **Acceptance criteria:** `GET /api/git/repositories?project=<id>` returns deterministic workspace-relative repositories including `.` when applicable; all Git routes accept optional `repository` in query/body and run against that repository; all Worktrees routes accept the same selector; omitted selectors retain existing workspace-root behavior; absolute, escaping, nonexistent, symlink-escaping, and non-repository selectors cannot target outside/arbitrary directories; discovery handles `.git` files/directories and nested independent repositories without traversing Git metadata.
  **Validation:** Implement and run focused Git and Worktrees backend tests covering discovery, safe resolution, root fallback, nested targeting, invalid selectors, and request forwarding; run `npm run typecheck --` if supported or `npm run typecheck`, plus scoped ESLint for touched backend files, and report any pre-existing failures distinctly.
  **Summary:** Added shared canonical workspace-relative containment utilities; a Git repository service for deterministic `.git` file/directory discovery and selector validation; repository discovery and targeting across all Git routes; and safe selector parsing/resolution across every Worktrees route. Updated Worktrees contracts and focused route fixtures/tests. Existing parsing/worktree workflow services were unchanged. The backend test suite passed (386 tests), `npm run typecheck` passed, and scoped ESLint passed with only pre-existing boundaries configuration deprecation warnings.

- [x] **ID:** 2 | **Batch:** 1
  **Task:** Implement the repository-aware Source Control UI and controller so users can select any discovered nested repository and every panel action operates on that selection.
  **Files:**
  ./src/components/git-panel/types/types.ts - Add repository discovery payloads and active-repository fields/options to frontend contracts.
  ./src/components/git-panel/hooks/useGitPanelController.ts - Discover repositories, manage selection/reset/stale responses, and include `repository` in every Git API request.
  ./src/components/git-panel/view/GitPanel.tsx - Coordinate repository selection, repository-specific keys/paths, error/init behavior, revert, tabs, and header props.
  ./src/components/git-panel/view/GitPanelHeader.tsx - Render an accessible repository picker near the branch selector and support repository switching/rediscovery UX.
  ./src/components/git-panel/hooks/useRevertLocalCommit.ts - Include the active repository selector in revert requests and reset appropriately.
  ./src/components/git-panel/hooks/useWorktreesController.ts - Include the active repository selector in every Worktrees request and stale-state key.
  ./src/components/git-panel/view/worktrees/WorktreesView.tsx - Accept and pass active repository context into the Worktrees controller.
  ./src/components/git-panel/view/changes/ChangesView.tsx - Use a repository-specific path/cache key for commit composer state.
  src/components/main-content/view/MainContent.tsx - Existing Source Control mount/editor callback is contextual and should remain compatible.
  **Acceptance criteria:** Source Control automatically selects `.` when the workspace root is a repository or otherwise the first nested repository; users can switch among all discovered repositories from the header; status, diffs, history, branches, remotes, staging, commits, file operations, initialization, revert, and Worktrees target only the active repository; switching repository clears stale state and preserves a valid selection across refreshes; opening a nested-repository file uses its workspace-relative path in the editor; no-repository workspaces retain the existing initialize flow and select the initialized root afterward; layouts remain usable on mobile and desktop.
  **Validation:** Add focused tests for any extracted pure repository/path helpers using the existing frontend Node-test pattern; run those tests, `npm run typecheck`, and scoped ESLint for touched frontend files, and report any pre-existing failures distinctly.
  **Summary:** Added repository discovery/selection and project+repository state scoping to the Git panel controller; forwarded the selector through all Git, revert, and Worktrees requests; added an accessible responsive repository picker with rediscovery; translated nested file opens to workspace-relative paths; keyed Changes and Worktrees state plus commit drafts by repository; and added focused repository/path helper tests. Repository helper tests, focused backend tests, combined `npm run typecheck`, and scoped ESLint all pass; ESLint reports only pre-existing boundaries configuration deprecation warnings.

- [x] **ID:** 3 | **Batch:** 2
  **Task:** Replace marker-only repository qualification with authoritative Git work-tree-root validation so a non-repository workspace containing an invalid `.git` marker does not mask valid child repositories.
  **Files:**
  ./server/modules/git/git-repository.service.ts - Validate every marker candidate and explicit selector as a real Git work-tree root rather than accepting `.git` presence alone.
  ./server/modules/git/git.routes.ts - Compose the repository service with the existing injected subprocess adapter without duplicating Git command orchestration or weakening route behavior.
  ./server/modules/git/tests/git-repository.service.test.ts - Add focused discovery and resolution regressions for an invalid root marker with a valid nested repository, valid root/nested repositories, and `.git` file support.
  ./server/modules/git/tests/git-init.routes.test.ts - Keep route dependency fixtures compatible and add route-level coverage only if needed to prove composition/response behavior.
  ./server/modules/git/git.module.ts - Context for the existing filesystem and subprocess dependency composition; modify only if the service dependency boundary requires it.
  ./server/shared/utils.ts - Existing canonical workspace containment remains authoritative and must not be weakened.
  ./src/components/git-panel/utils/repositoryUtils.ts - Existing selection correctly prefers `.`; contextual evidence that backend false positives, not selection ordering, are the defect.
  **Acceptance criteria:** A workspace that is not a valid Git work tree but has an empty/malformed `.git` marker returns only its valid nested repositories; `cloudcli-src`-style valid child repositories resolve and operate normally; valid root repositories remain represented as `.` and sorted first; `.git` files used by worktrees/submodules remain supported; explicit selectors with false markers are rejected; Git validation confirms that the candidate itself is the canonical work-tree root rather than merely somewhere inside another repository; containment and omitted-selector compatibility remain unchanged.
  **Validation:** Implement and run the focused Git repository-service and affected route tests, reproduce discovery against a temporary non-Git root with a valid child repository, run `npm run typecheck`, and run scoped ESLint for touched backend files; report unrelated pre-existing failures separately.
  **Summary:** Injected the existing Git subprocess runner into `GitRepositoryService` and changed discovery/explicit-selector qualification to require `git rev-parse --show-toplevel` to resolve canonically to the candidate itself. Added focused real-Git service regressions covering invalid root markers with valid children, valid root/nested sorting, false nested markers inside another work tree, explicit rejection, and `.git` file worktrees. Route composition now reuses its existing subprocess orchestration. Focused tests (5), `npm run typecheck`, and scoped ESLint all passed.

- [x] **ID:** 4 | **Batch:** 3
  **Task:** Make repository discovery the authoritative prerequisite for Git panel loading, eliminating unscoped root-status requests and stale state when the selected workspace is not Git but contains valid child repositories.
  **Files:**
  ./src/components/git-panel/hooks/useGitPanelController.ts - Coordinate project reset, discovery, active-scope publication, status loading, error handling, and stale-response guards without racing effects.
  ./src/components/git-panel/view/GitPanel.tsx - Render initialization only after successful discovery proves there are no repositories, and expose repository-discovery failures distinctly.
  ./src/components/git-panel/types/types.ts - Add any controller/API state needed to distinguish pending discovery, discovery failure, and confirmed empty discovery.
  ./src/components/git-panel/utils/repositoryUtils.ts - Keep deterministic selection semantics and host extracted scope/decision helpers if useful for focused tests.
  ./src/components/git-panel/utils/repositoryUtils.test.ts - Add regressions for discovery-gated loading/empty-state decisions or extracted pure orchestration helpers.
  ./src/components/git-panel/view/GitRepositoryErrorState.tsx - Reuse or minimally extend the error presentation without offering Git initialization for repository-discovery failures.
  ./server/modules/git/git.routes.ts - Context only: repository discovery returns `{ repositories }` and root status without a selector correctly reports non-Git for `/home/dev/code`.
  **Acceptance criteria:** Selecting project `/home/dev/code` does not issue or commit an unscoped root Git status before discovery; successful discovery of `cloudcli-src` activates it and loads its status automatically; the initialize prompt appears only after discovery successfully returns an empty repository list and root status confirms non-Git; discovery HTTP/non-JSON/error responses produce a visible retryable discovery error rather than an initialize prompt; project/repository switches cannot commit stale discovery or Git responses; manual rediscovery preserves a valid active repository and transitions cleanly if repositories change.
  **Validation:** Add and run focused frontend tests for extracted repository loading/empty-state logic, run the existing repository utility tests, run `npm run typecheck`, run scoped ESLint for touched frontend files, and run `npm run build:client` to verify the lazy Git panel bundle compiles; report unrelated pre-existing failures separately.
  **Summary:** Made discovery an explicit pending/success/error prerequisite for status loading, atomically published repository scope before nested Git requests, preserved valid selections during rediscovery, and added request-generation/scope guards for discovery, status, branches, remotes, commits, and diffs. Discovery failures now remain distinct and retryable, while Git initialization is gated on successful empty discovery plus root non-Git status. Added focused pure decision regressions. Repository utility tests (5), typecheck, scoped ESLint, and the client build/bundle budget all passed.

- [x] **ID:** 5 | **Batch:** 4
  **Task:** Optimize backend nested-repository discovery so large non-Git workspace roots return usable child repositories promptly instead of serially walking generated and vendor trees.
  **Files:**
  ./server/modules/git/git-repository.service.ts - Add safe directory-pruning and bounded-concurrency traversal while preserving candidate validation and deterministic results.
  ./server/modules/git/tests/git-repository.service.test.ts - Add regressions proving ignored generated/vendor trees are not traversed, ordinary nested repositories remain discoverable, and concurrent traversal retains stable sorting and safety.
  ./server/modules/git/git.routes.ts - Context only: the discovery endpoint delegates to the service and should retain its response contract.
  ./server/modules/git/git.module.ts - Context only unless service dependencies require composition changes.
  ./package.json - Provides focused tests, typecheck, lint, and server build commands for validation.
  **Acceptance criteria:** Discovery for `/home/dev/code` returns `cloudcli-src` and other eligible repositories in seconds rather than roughly 108 seconds; common generated/vendor/cache directories are skipped without excluding normal source directories; traversal uses a bounded concurrency limit and does not create unbounded filesystem/Git subprocess fan-out; root-first/path-sorted determinism, `.git` file support, symlink avoidance, canonical deduplication, invalid-marker rejection, and explicit selector resolution remain unchanged; focused tests do not depend on `/tmp` and create any fixtures only under the project workspace.
  **Validation:** Add and run focused Git repository-service tests, benchmark the live authenticated `/api/git/repositories` request for the `/home/dev/code` project, run `npm run typecheck`, scoped ESLint for touched backend files, and `npm run build:server`; do not use `/tmp`, and report unrelated pre-existing failures separately.
  **Summary:** Added conservative pruning for common VCS, dependency, build, generated, and cache directories plus breadth-first traversal in batches of eight, preserving marker qualification, canonical deduplication, symlink avoidance, and deterministic final sorting. Moved focused fixtures under the project test tree and added pruning/concurrency/sorting/symlink regressions. Six focused tests, scoped ESLint, typecheck, and server build pass. Direct service discovery completed in 3.867 seconds; an authenticated endpoint benchmark against a separately started built server completed in 2.080 seconds with HTTP 200 and returned `cloudcli-src` plus the other eligible repositories.

- [!] **ID:** 6 | **Batch:** 5
  **Task:** Add a persistent, explicit repository selector row to Source Control so users can always see discovery progress and choose among nested Git repositories such as `cloudcli-src`.
  **Files:**
  ./src/components/git-panel/view/GitPanel.tsx - Render repository selection independently of active repository and branch/header state in every discovery state.
  ./src/components/git-panel/view/GitPanelHeader.tsx - Remove the conditional/duplicated repository selector from branch controls while keeping branch and remote actions intact.
  ./src/components/git-panel/view/GitRepositorySelector.tsx - Add a focused repository control with a visible label, current workspace-relative path, loading/empty/error states, discovered count, selection options, and rediscovery action.
  ./src/components/git-panel/types/types.ts - Add reusable selector/controller prop types only if needed.
  ./src/components/git-panel/hooks/useGitPanelController.ts - Preserve selection behavior and expose sufficient discovery state; adjust only if the selector needs a safer selection action.
  ./src/components/git-panel/utils/repositoryUtils.ts - Provide concise repository labels or selector-state helpers if extracted for testing.
  ./src/components/git-panel/utils/repositoryUtils.test.ts - Add focused tests for repository labels/selector state decisions.
  **Acceptance criteria:** Source Control always displays a clearly labeled `Repository` control immediately on opening; while discovery is pending it visibly says repositories are being discovered and offers a disabled/loading state rather than showing only an empty changes panel; after discovery it lists every returned repository and visibly shows the active workspace-relative path such as `cloudcli-src`; selecting another repository switches all Git state/actions to it; rediscovery remains available; empty results and discovery errors remain explicit and retryable; branch controls appear only when a repository is active but cannot hide repository selection; the control is usable on mobile and desktop and does not depend on hover; no `/tmp` path is used for implementation or validation.
  **Validation:** Add/run focused repository utility tests, run `npm run typecheck`, scoped ESLint for touched frontend files, and `npm run build:client`; perform an in-memory browser validation against the running app confirming the Repository control is visible during discovery and that returned options include `cloudcli-src`, without screenshots or filesystem output.
  **Summary:** Added a persistent `GitRepositorySelector` above the conditional branch header, with an explicit Repository label, disabled discovery/loading option, discovered count, current workspace-relative selection, empty/error details, and always-visible rediscovery action. Removed repository selection from `GitPanelHeader` while preserving branch/remote actions, and added tested repository label/discovery-message helpers. Focused utility tests (7), scoped ESLint, typecheck, and client build all passed. Marked incomplete because the required in-memory browser validation could not be performed: no browser automation capability was available in this agent environment, and no running-app endpoint could be identified with the available tooling.

# CHANGELOG

- **Item 2:** Implemented repository-aware Source Control discovery, selection, request scoping, stale resets, nested editor paths, repository-specific caches, Worktrees/revert forwarding, responsive picker UI, and focused helper tests.
- **Item 1:** Added secure workspace-relative repository discovery/resolution, applied optional repository targeting to all Git and Worktrees endpoints, updated shared contracts and route tests, and passed tests, typecheck, and scoped lint.
- **Item 3:** Replaced marker-only qualification with canonical Git work-tree-root validation through the injected subprocess runner, added focused real-repository discovery/resolution regressions, and passed focused tests, typecheck, and scoped lint.
- **Item 4:** Gated Git loading on successful repository discovery, added atomic scope/stale-response guards and retryable discovery errors, restricted initialization to confirmed empty workspaces, and passed focused tests, typecheck, scoped lint, and client build validation.

- **Item 5:** Added conservative generated/vendor/cache/VCS pruning and eight-way bounded traversal with focused workspace-local regressions; tests, lint, typecheck, and server build pass, and direct  discovery fell to 3.867 seconds, but authenticated endpoint benchmarking was blocked by HTTP 401.

- **Item 5:** Added conservative generated/vendor/cache/VCS pruning and eight-way bounded traversal with focused workspace-local regressions; tests, lint, typecheck, and server build pass, and direct /home/dev/code discovery fell to 3.867 seconds, but authenticated endpoint benchmarking was blocked by HTTP 401.

- **Item 6:** Added a persistent labeled repository selector with discovery/loading, count, current path, empty/error, selection, and rediscovery states; removed the duplicate header selector; utility tests, lint, typecheck, and client build pass, but required browser validation was blocked by unavailable browser automation/running-app access.
