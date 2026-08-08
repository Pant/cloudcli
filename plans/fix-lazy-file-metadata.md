# Fix Lazy File Metadata Loading

## CONTEXT

The visual File Explorer already lazy-loads the project root and each expanded directory with depth `0`, preserving the intended fast root-first behavior. Its shallow request plan explicitly sets `includeMetadata: false`, while the backend fills every metadata-free node with placeholder values (`size: 0`, `modified: null`, and empty permissions). The detailed and compact rows render those placeholders as real metadata, which is why ordinary non-empty files appear as `0 B` and have missing dates/permissions. File content opening and downloading use separate endpoints, so this defect is in explorer metadata loading/display rather than file bytes.

### FILES

./src/components/file-tree/hooks/useFileTreeData.ts - Owns root-first and per-directory lazy loading, immutable merges, cache hydration, refresh, stale-request protection, and complete-tree snapshots.
./src/components/file-tree/utils/fileTreeRequestUtils.ts - Builds the shallow explorer request plan that currently disables metadata.
./src/components/file-tree/utils/fileTreeUtils.ts - Provides immutable merge helpers, metadata formatting, cache primitives, and the focused File Tree utility tests' target behavior.
./src/components/file-tree/types/types.ts - Defines frontend File Tree node and request option contracts.
./src/components/file-tree/view/FileTreeNode.tsx - Renders size, modified time, and permissions in detailed and compact modes.
./src/components/file-tree/utils/fileTreeUtils.test.ts - Existing focused Node tests cover request planning, merging, lazy state, cache, search snapshots, and ZIP manifests.
./src/utils/api.file-tree.test.ts - Existing API tests verify File Tree request query construction.
./server/modules/file-tree/file-tree.service.ts - Produces real metadata with `lstat` when requested and placeholder metadata when metadata is disabled.
./server/modules/file-tree/tests/file-tree.service.test.ts - Existing backend tests prove shallow metadata-enabled traversal remains depth-limited and metadata-disabled traversal skips `lstat`.
./package.json - Defines focused test, typecheck, lint, and client build commands.
.agents/skills/backend-module-standards/SKILL.md - Backend standards are contextual because the existing backend behavior should remain unchanged unless implementation evidence requires otherwise.
plans/faster-file-explorer.md - Documents the completed lazy-loading architecture and its original decision to disable metadata on the critical path.

## ANALYSIS

The regression is caused by conflating two independent performance controls: recursion depth and entry metadata. Depth `0` already limits each explorer request to one `readdir` and the direct children of the requested directory, so lazy loading can remain intact while metadata is enabled for only those visible children. The current metadata-free optimization saves direct-child `lstat` calls but makes the returned `size: 0` placeholders indistinguishable from legitimate empty files; the UI consequently presents incorrect information for every loaded level.

The safest correction is to keep root-first/per-directory requests at depth `0` but request real metadata for each directory page. This preserves all important lazy behavior: no descendant traversal before expansion, request deduplication, generation guards, cached tree reuse, local directory loading, complete-tree-on-demand search, and subtree-on-demand ZIP export. Because backend shallow metadata support already exists, the likely implementation is frontend-only: change the explorer request plan, ensure tests explicitly prove depth remains `0` while metadata is enabled, and add metadata merge/display safeguards where needed so cache/root revalidation does not regress real metadata.

The implementation should also audit the related file surfaces for correctness rather than only changing one boolean. In particular, it must verify that root revalidation and nested merges retain the fresh metadata returned by the server, true zero-byte files still format as `0 B`, unavailable metadata is not falsely displayed as zero, directory expansion still loads only direct children, refresh updates metadata on loaded branches, search and ZIP behavior remain authoritative, and errors do not wipe usable cached data. No product decision is blocking: the user's priority is correctness while retaining lazy loading, so real metadata for each shallow page is the appropriate trade-off.

## PLAN

1. Repair the visual File Explorer's lazy request and metadata presentation flow so every shallow root/directory response contains real direct-child metadata without restoring recursive eager traversal.
2. Add focused regression coverage for request planning, immutable metadata replacement, true zero-byte versus unavailable size formatting, and refresh/cache behavior as applicable.
3. Validate focused frontend tests, typecheck, targeted lint, and the client build; run backend File Tree tests if backend files are touched or to confirm the existing depth/metadata contract when practical.

## GUIDELINES

- Preserve root-first and expand-on-demand lazy loading. Normal explorer requests must remain depth `0`; do not revert to a recursive project-tree request.
- Request accurate metadata for the direct children returned by each lazy page. A legitimate empty file may display `0 B`; missing/unavailable metadata must not masquerade as a known zero-byte size.
- Keep `children === undefined` as unloaded and `children: []` as loaded empty.
- Preserve generation guards, abort behavior, in-flight deduplication, recent-project caching, background root revalidation, loaded-branch refresh planning, complete-tree search snapshots, and complete-subtree ZIP export.
- Ensure immutable root/nested merges use the newest node metadata while preserving already-loaded descendants for matching directories.
- Avoid unrelated File Tree UI or backend refactors. Existing backend listing behavior should be reused unless a verified backend defect requires a narrowly scoped correction.
- If backend code under server/ is modified, follow .agents/skills/backend-module-standards/SKILL.md, keep routes thin, use injected filesystem dependencies, and update module-local tests.
- Run scoped validation first; do not use VCS operations.

## TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Fix all File Explorer metadata correctness issues introduced by metadata-free shallow listings while retaining the existing lazy-loading architecture. Audit the root and nested request plans, cache/revalidation and immutable merge behavior, row formatting, refresh behavior, and related search/download boundaries; implement the smallest coherent correction so direct children have accurate size/modified/permission metadata without recursive eager traversal. Add focused regressions for the corrected behavior.
  **Files:**
  ./src/components/file-tree/hooks/useFileTreeData.ts - Update or verify lazy root/directory loading, merges, cache/revalidation, and refresh behavior.
  ./src/components/file-tree/utils/fileTreeRequestUtils.ts - Correct the shallow request plan while preserving depth-zero loading.
  ./src/components/file-tree/utils/fileTreeUtils.ts - Update metadata formatting or merge helpers if needed for accurate known-versus-unavailable values.
  ./src/components/file-tree/types/types.ts - Refine metadata contracts only if needed to represent availability correctly.
  ./src/components/file-tree/view/FileTreeNode.tsx - Ensure detailed/compact rows display accurate metadata and do not present unknown values as known zeroes.
  ./src/components/file-tree/utils/fileTreeUtils.test.ts - Add focused request, merge, refresh/cache, and formatting regression coverage.
  ./src/utils/api.file-tree.test.ts - Update request-query expectations if the corrected plan/API behavior requires it.
  ./server/modules/file-tree/file-tree.service.ts - Reuse the existing shallow metadata path; modify only if tests reveal a backend correctness issue.
  ./server/modules/file-tree/tests/file-tree.service.test.ts - Confirm or extend backend shallow traversal and metadata coverage if backend behavior is involved.
  ./package.json - Use repository test, typecheck, lint, and build commands for validation.
  .agents/skills/backend-module-standards/SKILL.md - Mandatory standards if any backend file is changed.
  plans/faster-file-explorer.md - Context for invariants established by the prior lazy-loading implementation; do not edit.
  **Acceptance criteria:** Uncached root opening and directory expansion still request depth `0` only; files returned at every lazily loaded level show their real size, modification time, and permissions when available; legitimate empty files still display `0 B`, while unavailable metadata is not falsely shown as a known zero; root revalidation and loaded-branch refresh replace stale metadata while preserving loaded descendants; cached trees remain visible during background revalidation; stale/project-switched requests and rapid duplicate expansions remain guarded/deduplicated; search and ZIP continue using their authoritative complete requests; no unrelated behavior regresses.
  **Validation:** Add/update focused Node tests for depth-zero metadata-enabled explorer plans, real metadata replacing placeholders through root/nested merges, known zero-byte versus unavailable size formatting, and any changed refresh/cache helper behavior. Run `node --import tsx --test src/components/file-tree/utils/fileTreeUtils.test.ts src/utils/api.file-tree.test.ts`, `npm run typecheck`, targeted ESLint for touched frontend files, and `npm run build:client`. If backend files change, also run `npx tsx --tsconfig server/tsconfig.json --test server/modules/file-tree/tests/file-tree.service.test.ts server/modules/file-tree/tests/file-tree.routes.test.ts`, targeted backend ESLint, and `npm run build:server`.
  **Summary:** Updated `fileTreeRequestUtils.ts` so all lazy root/directory and loaded-branch refresh plans remain depth `0` while requesting metadata. Updated `fileTreeUtils.ts` so unavailable/invalid sizes format as `-` while legitimate zero-byte files remain `0 B`. Extended `fileTreeUtils.test.ts` with request-plan, root/nested fresh-metadata merge, and size-availability regressions. Existing hook merge/cache/revalidation, generation/deduplication, complete-search, and ZIP paths required no code changes; backend behavior was reused unchanged.

## CHANGELOG

- **Item 1:** Enabled metadata on depth-zero explorer pages, distinguished unavailable file sizes from true zero-byte files, and added focused request/merge/formatting regressions; frontend tests, typecheck, targeted ESLint, and client build pass.
