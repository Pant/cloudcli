# CONTEXT

## Files

./package.json - Defines the current `typecheck` script as two sequential full TypeScript checks and already provides `concurrently` as a development dependency.
./tsconfig.json - Configures the frontend/shared no-emit TypeScript project currently checked first by `npm run typecheck`.
./server/tsconfig.json - Configures the backend/shared TypeScript project currently checked second by `npm run typecheck`.
./.gitignore - Defines ignored generated artifacts and must cover any persistent TypeScript build-info cache not stored under an already ignored path.
AGENTS.md - Requires the backend module standards whenever backend code under `server/` is changed or reviewed.
.agents/skills/backend-module-standards/SKILL.md - Supplies backend-specific constraints; this tooling-only optimization must not trigger unrelated backend refactoring.
.github/workflows/desktop-release.yml - Runs `npm run typecheck`, so the optimized command must remain CI-safe and preserve the same combined checking scope.
.github/workflows/desktop-windows-branch-build.yml - Runs `npm run typecheck` in a branch-build workflow and depends on its exit status.
.github/workflows/desktop-macos-branch-build.yml - Runs `npm run typecheck` in a branch-build workflow and depends on its exit status.

# ANALYSIS

`npm run typecheck` currently invokes the frontend and backend compilers sequentially, and neither invocation persists incremental build information. Baseline extended diagnostics in this workspace measured about 18.3 seconds for the frontend project and 7.3 seconds for the backend project, making the sequential command roughly the sum of both checks. Trial incremental invocations retained full cold-check behavior while reducing unchanged reruns to roughly 3.6-3.9 seconds per project. Because the projects have separate configurations and output/cache identities, they can also run concurrently without correctness coupling; on a cold run, wall-clock time should approach the slower frontend check rather than the sum.

The safest optimization is therefore to expose separate client/server typecheck scripts, enable a distinct persistent incremental build-info file for each check, and run both scripts concurrently from the existing public `typecheck` command. The cache files should live under an ignored generated location, remain unique per project, and not alter production emission settings. Validation must prove that a clean-cache run succeeds, an unchanged warm run succeeds materially faster, and an intentional type error in each project still makes the combined command fail. Concurrency increases peak memory because both compilers overlap, but the observed individual peaks (approximately 581 MB and 455 MB) are reasonable for the current development/CI setup; if the combined benchmark shows instability, incremental caching without parallelism is the fallback.

# PLAN

1. Split the public typecheck command into independently callable frontend and backend checks, run them concurrently, and give each check a persistent incremental cache.
2. Keep generated cache state ignored and benchmark clean versus unchanged runs while confirming failures still propagate from either compiler.

# GUIDELINES

- Preserve `npm run typecheck` as the single command used by developers and CI, checking both existing projects and returning nonzero if either fails.
- Use the repository's installed tooling; do not add a dependency when `concurrently` and TypeScript already provide the needed behavior.
- Give frontend and backend distinct `tsBuildInfoFile` paths to prevent cache collisions.
- Keep cache artifacts out of tracked source and production output; prefer an already ignored generated directory or explicitly update ./.gitignore.
- Do not alter strictness, includes/excludes, path aliases, module resolution, or the backend emission contract merely to improve timing.
- Backend configuration work must respect ./.agents/skills/backend-module-standards/SKILL.md, but no backend application module should be changed.
- Avoid unrelated refactors and scope validation to the typecheck command and its two TypeScript projects.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Optimize `npm run typecheck` by running the existing frontend and backend checks concurrently with separate persistent TypeScript incremental caches, then verify clean/warm performance and error propagation.
  **Files:**
  ./package.json - Split and compose the frontend/backend typecheck scripts using existing dependencies while preserving the public command.
  ./tsconfig.json - Add or support the frontend project's unique incremental build-info cache without changing its checking scope.
  ./server/tsconfig.json - Add or support the backend project's unique incremental build-info cache without changing its checking or build-emission scope.
  ./.gitignore - Ensure generated build-info caches cannot become tracked artifacts.
  AGENTS.md - Apply the repository guidance relevant to reviewing the backend TypeScript configuration.
  .agents/skills/backend-module-standards/SKILL.md - Follow backend constraints while avoiding unrelated module changes.
  .github/workflows/desktop-release.yml - Contextual CI consumer whose existing `npm run typecheck` invocation must continue to work unchanged.
  .github/workflows/desktop-windows-branch-build.yml - Contextual CI consumer whose existing `npm run typecheck` invocation must continue to work unchanged.
  .github/workflows/desktop-macos-branch-build.yml - Contextual CI consumer whose existing `npm run typecheck` invocation must continue to work unchanged.
  **Acceptance criteria:** `npm run typecheck` still checks both the frontend/shared and backend/shared project scopes; the two checks execute concurrently with non-colliding persistent incremental state; unchanged reruns are materially faster than the measured sequential baseline; cache files are ignored; and a type error in either project causes the combined command to fail.
  **Validation:** Remove only the configured typecheck cache files, run and time a clean `npm run typecheck`, immediately run and time it again to demonstrate the warm-cache improvement, and verify both project-specific scripts independently. Temporarily introduce and then fully revert one unmistakable TypeScript error under `src/` and one under `server/`, confirming each makes `npm run typecheck` nonzero; finish with a successful clean working-tree `npm run typecheck`. Report timings and any resource trade-off.
  **Summary:** Reviewed and retained the partial implementation in `package.json`, `tsconfig.json`, `server/tsconfig.json`, and `.gitignore`: the public command runs distinct incremental frontend/backend checks concurrently, caches use separate ignored root files, and `prebuild:server` removes both `dist-server` and the shared backend build-info cache so an emitting build cannot incorrectly reuse no-emit state. Clean concurrent typecheck completed in 24.330s and the unchanged warm run in 4.819s; both scoped scripts passed, deliberate frontend and backend errors each failed the public command, and typecheck followed by `build:server` recreated `dist-server/server/index.js`. Final typecheck passed. Cold concurrency is only modestly faster than the old ~25.6s sequential baseline and increases peak resource overlap, while warm checks are materially faster.

# CHANGELOG

- **Item 1:** Confirmed concurrent frontend/backend incremental typechecking with separate ignored caches; retained backend prebuild cache/output cleanup to preserve emitting builds. Validated 24.330s clean and 4.819s warm runs, scoped checks, failure propagation in both scopes, server output recreation, and final success.
