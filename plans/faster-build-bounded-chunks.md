# CONTEXT

## Files

./package.json - Defines `build` as sequential client/server builds, the Vite client command, and the TypeScript-plus-alias server build whose cleanup currently removes all server output and backend build info.
./vite.config.js - Contains the client build configuration, currently only setting `outDir` and a permissive 1000 kB raw chunk warning threshold.
./server/tsconfig.json - Configures the emitting backend TypeScript project and currently shares its incremental build-info file with backend no-emit typechecking.
./tsconfig.json - Configures frontend no-emit incremental checking; it is contextual to cache naming and must remain independent from production bundling.
./.gitignore - Ignores generated distributions and current typecheck build-info files; any new build caches or reports must remain untracked.
./src/main.jsx - The client entrypoint whose static dependency graph determines the initial Vite chunk.
./src/App.tsx - Defines root providers and routing imports in the initial graph; it is relevant when evaluating safe startup code splitting.
./src/appRoutes.tsx - Statically imports `AppContent`, making the authenticated application shell part of the entry graph despite deeper component-level lazy imports.
./src/components/app/AppContent.tsx - Already lazy-loads the major sidebar and main-content feature surfaces, defining the existing split boundary to preserve.
./src/components/main-content/view/MainContent.tsx - Already lazy-loads heavy feature panels such as File Tree, Shell, Git, plugins, Browser Use, Task Master, and editor surfaces.
./src/components/code-editor/utils/editorExtensions.ts - Uses dynamic CodeMirror language/merge/minimap imports and is relevant to preserving editor feature splitting.
./src/i18n/config.js - Uses `import.meta.glob` to lazy-load locale namespaces, generating many small chunks that must remain functionally available.
./scripts/validation/client-bundle-budget.mjs - New deterministic artifact validator to enforce the 100 kB gzip limit for every generated client JavaScript file.
AGENTS.md - Requires backend standards when backend code under `server/` is changed or reviewed.
.agents/skills/backend-module-standards/SKILL.md - Applies to the backend TypeScript configuration/build tooling while prohibiting unrelated module changes.
dist/assets/dist-HiE6FnVq.js - Current generated CodeMirror-related chunk measuring 101.84 kB gzip, over the requested limit.
dist/assets/index-C-gxYfYX.js - Current generated entry chunk measuring 102.95 kB gzip, over the requested limit.
dist/assets/Shell-CAQwfqCw.js - Current generated Shell chunk measuring 98.14 kB gzip, close to the requested limit and requiring budget headroom consideration.

# ANALYSIS

The current full build is sequential: a client build taking about 8.3 seconds wall-clock is followed by a server build taking about 11.0 seconds, so the public command should be able to reduce wall time by executing these independent output pipelines concurrently. The server build always deletes `dist-server` and its incremental state, meaning it receives no warm-build benefit; that cleanup was added to prevent no-emit typecheck state from suppressing emission because typechecking and building share `server/tsconfig.json`. A safer long-term arrangement is to separate backend typecheck and build configurations/caches, so production builds can retain valid emitting incremental state while still recreating missing output correctly. Any warm-server optimization must account for `tsc` incremental correctness when `dist-server` is removed externally; build scripts cannot blindly trust a cache if outputs are absent.

The Vite client baseline transforms 3301 modules in roughly 7.4 seconds internally, with CSS plugin work dominating reported hook time. Build speed may gain primarily from full-build parallelism rather than aggressive client transformations. Output inspection shows two JavaScript files exceed the requested post-gzip maximum: the entry chunk at 102.95 kB gzip and a CodeMirror-related chunk at 101.84 kB gzip; the Shell chunk is 98.14 kB and leaves little regression margin. Raw `chunkSizeWarningLimit` does not enforce gzip size, so a post-build budget validator is required. Vite/Rolldown chunk boundaries should be adjusted narrowly and deterministically to split the entry/runtime/vendor graph and CodeMirror packages without undoing existing React lazy boundaries or generating circular/manual-chunk hazards. The validator should gzip actual emitted bytes, reject every `dist/**/*.js` file above 100,000 bytes (interpreting the user's 100 kB literally and conservatively), print useful offenders, and run as part of `build:client` so CI, release, desktop, and direct client builds all enforce the contract.

Build performance acceptance should compare multiple runs rather than promising a large client-only reduction: a cold public build should beat the prior roughly 19.3-second sequential wall time if resource limits permit, and an unchanged repeat should benefit from safe backend incremental state where possible. Correctness and the hard gzip budget take priority over marginal speed. Concurrency can increase peak memory, so the implementation should fall back to the fastest stable composition if simultaneous Vite and TypeScript compilation exhausts the environment.

# PLAN

1. Add deterministic Vite chunk boundaries and a post-build JavaScript gzip budget check that is automatically enforced by every client/full production build.
2. Separate backend no-emit and emitting incremental state, make repeated server builds safely incremental while recreating missing outputs, and run client/server production builds concurrently when stable.
3. Benchmark clean and warm builds, verify every emitted client JavaScript artifact is at or below 100,000 gzip bytes, and prove build/typecheck/output-failure contracts remain intact.

# GUIDELINES

- Preserve `npm run build`, `npm run build:client`, and `npm run build:server` as public commands used by release, desktop, package, and CI workflows.
- The 100 kB limit applies to every generated client `.js` file under `dist`, measured by gzip-compressing the emitted bytes; enforce a hard maximum of 100,000 bytes rather than relying on Vite's raw-size warning.
- Put the budget check in the client build pipeline so direct `npm run build:client` calls cannot bypass it; failures must identify offending files and measured gzip sizes.
- Use deterministic, package-aware chunking focused on the current over-budget entry and CodeMirror graphs. Preserve existing lazy imports and avoid unrelated frontend component refactors unless configuration-only splitting cannot meet the limit.
- Keep enough headroom where practical, especially for the current Shell chunk near 100 kB gzip, but do not create excessive tiny manual chunks merely to optimize a metric.
- Maintain runtime loading, locale glob imports, CodeMirror languages/extensions, syntax highlighting, Shell, and authenticated application startup behavior.
- Frontend and backend builds write disjoint output directories and may execute concurrently, but use failure propagation that terminates the combined command if either fails.
- Do not let backend no-emit typecheck cache state suppress production emission. Use distinct configurations/build-info files or equivalent isolation.
- A valid warm backend cache may be reused only when expected output exists; deleting `dist-server` must force a complete re-emission.
- Keep generated caches/reports ignored and do not add new dependencies when Node built-ins, TypeScript, Vite/Rolldown, and the existing `concurrently` package suffice.
- Follow ./.agents/skills/backend-module-standards/SKILL.md for backend configuration review, but do not change backend application modules.
- Avoid VCS operations and unrelated refactors.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Configure deterministic client chunking and add an automatically enforced artifact validator so every generated client JavaScript file is no larger than 100,000 bytes after gzip.
  **Files:**
  ./vite.config.js - Add narrow package-aware chunk strategy and production build settings for the current entry and CodeMirror overages without breaking lazy boundaries.
  ./scripts/validation/client-bundle-budget.mjs - Implement the Node-built-in gzip artifact validator with clear failure output and a reusable 100,000-byte limit.
  ./package.json - Integrate the budget validator into `build:client` and expose a direct validation command if useful.
  ./src/main.jsx - Preserve the current entrypoint behavior while understanding entry graph composition; modify only if configuration splitting alone cannot provide a safe budget.
  ./src/App.tsx - Preserve provider/router startup behavior; modify only if a targeted lazy boundary is required to bring the entry chunk safely below budget.
  ./src/appRoutes.tsx - Preserve shared route identity and optional session routing; modify only if safely lazy-loading the app shell is needed.
  ./src/components/app/AppContent.tsx - Preserve its existing major lazy boundaries and startup semantics.
  ./src/components/main-content/view/MainContent.tsx - Preserve existing feature-panel lazy boundaries and resulting chunks.
  ./src/components/code-editor/utils/editorExtensions.ts - Preserve dynamic CodeMirror feature imports while splitting their shared package graph below budget.
  ./src/i18n/config.js - Preserve dynamic locale namespace loading across all supported languages.
  dist/assets/dist-HiE6FnVq.js - Contextual current CodeMirror-related gzip offender at 101.84 kB.
  dist/assets/index-C-gxYfYX.js - Contextual current entry gzip offender at 102.95 kB.
  dist/assets/Shell-CAQwfqCw.js - Contextual near-limit Shell output at 98.14 kB.
  **Acceptance criteria:** `npm run build:client` succeeds with equivalent application/runtime behavior; every emitted `dist/**/*.js` file measures at most 100,000 gzip bytes; an intentional over-budget fixture or validator-target override proves the validator exits nonzero and reports the offending file; the validator is automatically invoked by the normal client build; and chunking does not collapse existing lazy feature/locale/editor boundaries.
  **Validation:** Run and time a baseline/updated `npm run build:client`; run the direct bundle-budget validation command; independently gzip and enumerate all `dist/**/*.js` outputs to identify the maximum; test the validator failure path using an isolated temporary output fixture outside the repository or a supported temporary target argument, then remove it; run `npm run typecheck:frontend`; inspect emitted imports/chunk names sufficiently to confirm startup, locale, CodeMirror, syntax-highlighter, and Shell chunks remain loadable.
  **Summary:** Added supported Vite 8/Rolldown `output.codeSplitting` package groups for CodeMirror, syntax highlighting, terminal, React, and i18n graphs while preserving all source lazy boundaries. Added `scripts/validation/client-bundle-budget.mjs`, a Node-built-in recursive gzip validator with a testable target-directory argument and 100,000-byte hard limit, and wired it into `build:client` plus `validate:client-bundle`. Updated client build completed in 8.98s wall time; independent enumeration found 214 JavaScript files with `dist/assets/terminal-DjUtgNOr.js` largest at 82,757 gzip bytes. Direct validation, isolated 150,068-byte failure fixture, frontend typecheck, and emitted entry/locale/CodeMirror/highlighter/Shell inspection all passed; no frontend source files changed.

- [x] **ID:** 2 | **Batch:** 1
  **Task:** Isolate backend emitting incremental state from no-emit typechecking and optimize the public full build by composing client and server builds concurrently without risking missing server outputs.
  **Files:**
  ./package.json - Update backend build/typecheck composition, safe output/cache preparation, and the public `build` concurrency/failure behavior.
  ./server/tsconfig.json - Preserve the canonical backend compiler options and emission scope while supporting distinct no-emit versus emitting cache state.
  ./server/tsconfig.typecheck.json - Add a backend no-emit configuration extending the canonical config with a separate typecheck cache if this is the clearest isolation mechanism.
  ./.gitignore - Ignore any distinct backend build/typecheck cache artifacts.
  ./AGENTS.md - Apply repository guidance for backend configuration work.
  ./.agents/skills/backend-module-standards/SKILL.md - Follow backend constraints without touching application modules.
  **Acceptance criteria:** `npm run build` runs independent client/server pipelines concurrently when stable and fails if either pipeline fails; `npm run typecheck:backend` remains no-emit with cache state distinct from server build emission; unchanged repeated `npm run build:server` is faster when outputs exist; deleting `dist-server` still causes complete server output recreation; and the resulting `dist-server/server/index.js` is runnable/resolvable as before.
  **Validation:** Time a clean server build and an immediate unchanged repeat; run backend typecheck before and after server builds; delete `dist-server` while retaining any emitting build cache and confirm `npm run build:server` recreates `dist-server/server/index.js`; temporarily introduce and fully revert a backend type error to confirm both build and backend typecheck fail; finish with successful `npm run build:server` and `npm run typecheck:backend`. Report any cold-concurrency memory trade-off.
  **Summary:** Preserved concurrent `build` composition with `--kill-others-on-fail`, isolated emitting and no-emit state in `.build-backend.tsbuildinfo` and `.typecheck-backend.tsbuildinfo`, and added `scripts/validation/prepare-server-build.mjs` to derive every expected TypeScript output and invalidate only incomplete server output/cache state before emission. Clean/warm server builds measured 9.638s/4.037s. Backend typecheck measured 6.793s before and 4.551s after builds; deleting either the entry output or all `dist-server` while retaining cache caused full recreation. Temporary backend type error made build, typecheck, and concurrent public build fail; it was fully reverted. Final server build/typecheck and entry syntax check passed; caches are ignored. Concurrent validation showed no memory issue in this environment.

- [x] **ID:** 3 | **Batch:** 2
  **Task:** Reconcile the client budget and backend build optimizations in the public build, benchmark clean and warm runs, and harden any integration issue found without broadening scope.
  **Files:**
  ./package.json - Validate and, only if needed, correct the final public build composition and automatic budget enforcement produced by Items 1 and 2.
  ./vite.config.js - Validate and, only if needed, tune final chunk boundaries against the hard gzip limit.
  ./scripts/validation/client-bundle-budget.mjs - Validate and, only if needed, harden budget enforcement and diagnostics.
  ./server/tsconfig.json - Validate canonical emitting backend behavior after the separate typecheck configuration is introduced.
  ./server/tsconfig.typecheck.json - Validate no-emit backend checking remains isolated from emission.
  ./.gitignore - Confirm all generated build information remains ignored.
  dist/index.html - Generated entry manifest whose script/modulepreload references must resolve to existing files after chunk changes.
  dist-server/server/index.js - Required generated backend entrypoint proving full server emission.
  **Acceptance criteria:** A clean `npm run build` completes successfully and faster than the prior approximately 19.3-second sequential baseline when the environment can sustain concurrency; an immediate unchanged full build is no slower and preferably materially faster; every emitted client JavaScript file is at most 100,000 gzip bytes with the validator passing; generated HTML references existing artifacts; required server output exists; and both frontend/backend typechecks still pass.
  **Validation:** Remove only build outputs and configured build caches, then time a clean `npm run build`; immediately time an unchanged `npm run build`; run the bundle-budget validator and an independent all-JS gzip enumeration; verify every `dist/index.html` local asset reference exists and `dist-server/server/index.js` exists; run `npm run typecheck`; if concurrent build failure propagation has not already been demonstrated, use a safe temporary configuration/error and fully revert it; finish with a successful `npm run build` and report clean/warm timing, largest gzip artifact, chunk count, and any memory/resource caveat.
  **Summary:** Integration validation required no source/config corrections. After removing only `dist`, `dist-server`, and `.build-backend.tsbuildinfo`, concurrent clean/warm public builds completed in 11.467s/8.312s versus the prior ~19.3s sequential baseline; the final successful build completed in 8.544s. Direct and independent recursive gzip checks passed for 214 client JavaScript files, with `dist/assets/terminal-DjUtgNOr.js` largest at exactly 82,757 bytes gzip. All 18 generated `/assets/` script/modulepreload/stylesheet references in `dist/index.html` resolved, `dist-server/server/index.js` existed and passed `node --check`, and concurrent frontend/backend `npm run typecheck` passed. Failure propagation was not repeated because Item 2 already proved it. No memory pressure was observed, though concurrent Vite/TypeScript execution can increase peak CPU/memory requirements on constrained environments.

# CHANGELOG

- **Item 1:** Added deterministic Rolldown package-aware client chunk groups and automatic 100,000-byte gzip validation; validated 214 JS artifacts with a maximum of 82,757 bytes gzip, including the isolated failure path and frontend typecheck.
- **Item 2:** Separated backend build/typecheck incremental caches, added portable expected-output completeness validation before server builds, retained concurrent fail-fast public build composition and `tsc-alias`, and validated clean/warm timing, output recreation, ignored caches, type-error failure paths, and final server build/typecheck.
- **Item 3:** Completed clean/warm/final public-build integration validation at 11.467s/8.312s/8.544s; confirmed 214 JS chunks with an 82,757-byte gzip maximum, all generated HTML asset references, server entry syntax/output, and full typechecking, with no corrective code changes required.
