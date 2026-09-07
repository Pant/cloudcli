# Frontend Workspace Tools

## Scope and boundaries

This map covers the project-scoped file explorer, editor, Git UI, terminal surfaces, and Browser monitor. These tools receive the selected `Project`/`ProjectSession` from the application shell and call authenticated backend endpoints; project selection/layout ownership belongs in `frontend-app-shell-navigation.md`, general client/auth contracts in `shared-contracts-api-transport.md`, and backend filesystem/Git/worktree behavior in `backend-workspaces-files-git.md`. It describes terminal wiring only far enough to navigate the workspace tool; realtime session/chat state belongs in their dedicated maps.

## Primary entry points

| Surface | Entry point | Role |
|---|---|---|
| Files | `FileTree` — `src/components/file-tree/view/FileTree.tsx` | Composes tree data, search, expansion, operations, upload, view modes, image viewing, and `onFileOpen`. |
| Editor | `CodeEditor` — `src/components/code-editor/view/CodeEditor.tsx` | Chooses editable, diff, media-preview, and binary presentations and binds document/sidebar/settings behavior. |
| Git | `GitPanel` — `src/components/git-panel/view/GitPanel.tsx` | Selects repository and Changes/History/Branches/Worktrees views around one controller. |
| Terminal | `Shell` — `src/components/shell/view/Shell.tsx` | Integrated xterm surface, controls, restart/connect state, and mobile terminal affordances. |
| Standalone terminal | `StandaloneShell` — `src/components/standalone-shell/view/StandaloneShell.tsx` | Thin reusable shell wrapper for a project/session or one plain-shell command, including completion reporting. |
| Browser | `BrowserUsePanel` — `src/components/browser-use/view/BrowserUsePanel.tsx` | Monitors agent-created browser sessions, screenshots/cursor, runtime readiness, stop/delete, and settings navigation. |

## Important symbols

### Files and opening

| Symbol | Path | Navigation role |
|---|---|---|
| `useFileTreeData` | `src/components/file-tree/hooks/useFileTreeData.ts` | Loads paged roots/directories, tracks request generations and per-directory paging, refreshes loaded branches, and supplies complete-tree loading for search. |
| `useFileTreeOperations` | `src/components/file-tree/hooks/useFileTreeOperations.ts` | Create, rename, delete, copy-path, and download orchestration; refreshes after mutations. |
| `useFileTreeUpload` | `src/components/file-tree/hooks/useFileTreeUpload.ts` | File picker/drop upload validation, batching/progress, and refresh. |
| `useFileTreeSearch` | `src/components/file-tree/hooks/useFileTreeSearch.ts` | Loads the complete tree when needed, filters it, and expands matching directories. |
| `FileTreeNode` | `src/components/file-tree/types/types.ts` | Core recursive file/directory shape including metadata and lazy-loading state. |
| `createExplorerDirectoryRequestPlan`, `FileTreeInFlightRequests` | `src/components/file-tree/utils/fileTreeRequestUtils.ts` | Define paged request shape and deduplicate in-flight tree reads. |
| `RecentProjectFileTreeCache`, `replaceDirectoryChildren`, `reconcileFileTreeMetadata` | `src/components/file-tree/utils/fileTreeUtils.ts` | Preserve recent project snapshots and safely merge lazy-loaded content/metadata. |
| `useFileOpenResolver` | `src/hooks/useFileOpenResolver.ts` | Wraps an editor opener; caches a flattened `api.getFiles` result per project and resolves bare/partial references. |
| `resolveFileReference` | `src/hooks/useFileOpenResolver.ts` | Normalizes/sanitizes a reference, prefers exact/path-suffix matches, then basename matches. |

### Editor and recovery

| Symbol | Path | Navigation role |
|---|---|---|
| `useCodeEditorDocument` | `src/components/code-editor/hooks/useCodeEditorDocument.ts` | Reads text, recognizes embedded diff snapshots/media/binary files, tracks baseline/dirty/save state, and coordinates recovery. |
| `CodeEditorFile`, `CodeEditorDiffInfo` | `src/components/code-editor/types/types.ts` | Editor input and optional old/new diff snapshots passed from Git. |
| `CodeEditorSurface` | `src/components/code-editor/view/subcomponents/CodeEditorSurface.tsx` | CodeMirror editing/diff surface. |
| `CodeEditorMediaPreview`, `CodeEditorBinaryFile` | `src/components/code-editor/view/subcomponents/CodeEditorMediaPreview.tsx`, `src/components/code-editor/view/subcomponents/CodeEditorBinaryFile.tsx` | Safe non-text branches; previewable media uses blob reads while other binaries are not editable. |
| `useEditorSidebar` / `EditorSidebar` | `src/components/code-editor/hooks/useEditorSidebar.ts`, `src/components/code-editor/view/EditorSidebar.tsx` | Loads and navigates the editor-side file tree. |
| `useCodeEditorSettings`, `loadLanguageExtensions`, `loadMergeCapability` | `src/components/code-editor/hooks/useCodeEditorSettings.ts`, `src/components/code-editor/utils/editorExtensions.ts` | Persist editor preferences and lazily install language/diff capabilities; the open-file header toggles the shared word-wrap preference and `CodeEditor` applies `EditorView.lineWrapping` immediately. |
| `EditorRecoveryStore`, `editorRecoveryStore` | `src/stores/editorRecoveryStore.ts` | IndexedDB recovery keyed by account/project/file; `get`, `put`, and `delete` fail closed when IndexedDB is unavailable and retain at most 50 records. |

### Git

| Symbol | Path | Navigation role |
|---|---|---|
| `useGitPanelController` | `src/components/git-panel/hooks/useGitPanelController.ts` | Repository discovery and all status/diff/branch/remote/stage/commit operations; guards async results by project/repository scope. |
| `GitPanelController`, `GitStatusResponse`, `FileOpenHandler` | `src/components/git-panel/types/types.ts` | Controller/UI contract, grouped status response, and Git-to-editor handoff. |
| `ChangesView`, `CommitComposer` | `src/components/git-panel/view/changes/ChangesView.tsx`, `src/components/git-panel/view/changes/CommitComposer.tsx` | Changed-file expansion, stage/unstage/discard/delete actions, commit message generation, and commit submission. |
| `HistoryView`, `BranchesView`, `WorktreesView` | `src/components/git-panel/view/history/HistoryView.tsx`, `src/components/git-panel/view/branches/BranchesView.tsx`, `src/components/git-panel/view/worktrees/WorktreesView.tsx` | Commit/diff history, local/remote branch operations, and worktree lifecycle UI. |
| `useWorktreesController` | `src/components/git-panel/hooks/useWorktreesController.ts` | Lists, creates, merges, and removes worktrees and coordinates project refresh/selection. |
| `workspaceFilePath`, `repositoryCacheKey`, `selectDiscoveredRepository` | `src/components/git-panel/utils/repositoryUtils.ts` | Translate repository-relative paths to workspace paths and isolate repository-scoped UI/cache state. |

### Terminal and Browser

| Symbol | Path | Navigation role |
|---|---|---|
| `useShellRuntime` | `src/components/shell/hooks/useShellRuntime.ts` | Owns xterm/socket refs and composes terminal lifecycle with shell connection lifecycle. |
| `useShellTerminal` | `src/components/shell/hooks/useShellTerminal.ts` | Creates/disposes xterm, fit/web-links/rendering support, sends input/resize, and handles responsive/mobile behavior. |
| `useShellConnection` | `src/components/shell/hooks/useShellConnection.ts` | Opens the shell WebSocket, sends the project/session `init` payload, writes output, and reports plain-command exit codes. |
| `getShellWebSocketUrl`, `parseShellMessage`, `sendSocketMessage` | `src/components/shell/utils/socket.ts` | WebSocket URL and typed JSON boundary. |
| `ShellOutgoingMessage`, `ShellIncomingMessage` | `src/components/shell/types/types.ts` | `init`/`resize`/`input` requests and output/error responses. |
| `installMobileTerminalSelection`, `transformTerminalInput` | `src/components/shell/utils/mobileTerminalSelection.ts`, `src/components/shell/utils/terminalShortcutKeys.ts` | Mobile selection/clipboard and modifier-key input policy. |
| `BrowserUseStatus`, `BrowserUseSession` (file-local types) | `src/components/browser-use/view/BrowserUsePanel.tsx` | Runtime capability and monitored session/screenshot/cursor response shapes. |
| `refresh`, `runAction` (component-local callbacks) | `src/components/browser-use/view/BrowserUsePanel.tsx` | Refresh status/sessions together and serialize mutation-then-refresh behavior. |

## Representative runtime flows

### File open, edit, recovery, and save

```mermaid
sequenceDiagram
  participant T as FileTree / chat / Git
  participant R as useFileOpenResolver
  participant E as CodeEditor
  participant D as useCodeEditorDocument
  participant A as api
  participant I as editorRecoveryStore
  T->>R: onFileOpen(path, optional diffInfo)
  R->>A: getFiles(projectId) (cached per project)
  R->>E: resolved path + diffInfo
  E->>D: CodeEditorFile
  D->>A: readFile(projectId, path)
  D->>I: get(accountId, projectId, path)
  Note over D,I: Dirty text is debounced to put(...); conflicting server baseline is flagged.
  D->>A: saveFile(projectId, path, content)
  D->>I: delete(...) after successful save
```

`FileTree.handleItemClick` lazy-loads directories, opens images in `ImageViewer`, and otherwise invokes `onFileOpen(item.path)`. A Git open is different: `useGitPanelController.openFile` requests `/api/git/file-with-diff`, converts repository-relative paths with `workspaceFilePath`, and passes old/current snapshots so `useCodeEditorDocument` can avoid a disk read and render a diff. Previewable media and known binary extensions never enter the text-save path.

### Git status to stage and commit

`GitPanel` gives `selectedProject.projectId` and the selected repository to `useGitPanelController`. Discovery calls `/api/git/repositories`; the controller then loads `/api/git/status`, per-file `/api/git/diff`, branches, and remote status. `ChangesView` selects files and calls `stageFiles` (`POST /api/git/stage`) or `unstageFiles`; `CommitComposer` can call `/api/git/generate-commit-message`, then `commitChanges` posts `/api/git/commit` and refreshes repository state. Branch/fetch/pull/push/publish/init and history endpoints live in the same controller; worktree requests are intentionally delegated to `useWorktreesController`.

### Integrated or standalone terminal

`Shell` passes project/session/plain-command settings to `useShellRuntime`. `useShellTerminal` initializes xterm; `useShellConnection` opens the URL from `getShellWebSocketUrl`, then sends `ShellInitMessage` with `projectPath` (`fullPath`/`path`), optional session id/provider, dimensions, command, and plain-shell flags. Terminal input and resize become socket messages; incoming `output` is written to xterm. For `StandaloneShell`, a command implies plain-shell mode, output text is scanned for `Process exited with code N`, and `onComplete` receives the exit code.

### Browser monitor

When visible, `BrowserUsePanel.refresh` concurrently reads `/api/browser-use/status` and `/api/browser-use/sessions`, preserves a valid selected session, and renders its latest screenshot plus viewport-relative agent cursor. Runtime installation posts `/api/browser-use/runtime/install`; stop and delete target the selected session, then `runAction` refreshes both lists. Agents create/control sessions elsewhere: this UI is a monitor and lifecycle surface, not a browser command authoring client.

## Shared dependencies and change points

- **Project identity:** filesystem/editor/Git APIs use `Project.projectId`; shell initialization uniquely needs the filesystem path (`fullPath || path`). Preserve that distinction when changing project models.
- **HTTP/auth boundary:** `src/utils/api.ts` supplies `authenticatedFetch`, `api.getFiles`, `api.getFileTreePage`, `api.readFile`, `api.readFileBlob`, `api.saveFile`, file mutations, and generic verbs. New endpoint typing/auth behavior should be coordinated with `shared-contracts-api-transport.md` rather than duplicated here.
- **Open-file contract:** keep optional diff payloads compatible across `FileOpenHandler`, `CodeEditorDiffInfo`, Git `openFile`, and `useFileOpenResolver`; ordinary file references should remain workspace-relative.
- **File explorer changes:** extend `useFileTreeData` for loading/reconciliation, `useFileTreeOperations` for mutations, and `FileTreeBody`/`FileTreeNode` for presentation. Respect request generations and loaded-branch preservation.
- **Editor changes:** add document lifecycle behavior in `useCodeEditorDocument`, presentation branches in `CodeEditor`, and CodeMirror capabilities in `editorExtensions.ts`. Recovery is account-scoped via `getUserCacheNamespace`.
- **Git changes:** add repository-scoped operations to `useGitPanelController` and expose them through `GitPanelController`; add view-only rendering in the corresponding view. Keep stale-response scope checks.
- **Terminal changes:** protocol fields belong in `shell/types/types.ts` and socket handling in `useShellConnection`; xterm behavior belongs in `useShellTerminal`. Do not put general application WebSocket/session state here.
- **Browser changes:** `BrowserUsePanel` currently owns local response types and endpoint calls; backend automation/runtime details are covered by `backend-persistence-automation-integrations.md`.

## Focused validation and tests

- File tree merge/cache/search helpers: `src/components/file-tree/utils/fileTreeUtils.test.ts`.
- Editor document, extensions, and header controls: `src/components/code-editor/hooks/useCodeEditorDocument.test.ts`, `src/components/code-editor/utils/editorExtensions.test.ts`, `src/components/code-editor/view/EditorSidebar.test.tsx`, `src/components/code-editor/view/subcomponents/CodeEditorHeader.test.tsx`.
- Git repository selection and commit graph: `src/components/git-panel/utils/repositoryUtils.test.ts`, `src/components/git-panel/utils/commitGraph.test.ts`.
- Terminal policy/keys: `src/components/shell/constants/constants.test.ts`, `src/components/shell/utils/terminalShortcutKeys.test.ts`.
- Documentation validation performed for this map: source paths/exports were checked and the four representative flows above were traced through their defining components/hooks and API calls.
