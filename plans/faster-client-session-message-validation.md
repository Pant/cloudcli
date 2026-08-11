# CONTEXT

## Files

./shared/cloudcli-contracts.ts - Defines the strict session-history envelope and normalized-message parsers used on both the client main thread and validation worker.
./shared/cloudcli-contracts.test.ts - Covers strict validation semantics, failure precedence, global message indexes, and reference preservation for session histories.
./src/utils/sessionHistoryValidation.ts - Selects synchronous versus worker validation, chunks histories, manages the reusable worker pool, aborts work, and falls back when workers fail.
./src/utils/sessionHistoryValidation.worker.ts - Runs strict message-chunk validation in a browser Web Worker.
./src/utils/sessionHistoryValidation.test.ts - Exercises threshold selection, worker pooling, deterministic failures, aborts, and worker-failure fallback.
./src/utils/apiClient.ts - Routes unconditional and conditional session-history responses through the asynchronous client validator before exposing them to the session store.
./src/utils/apiClient.test.ts - Verifies asynchronous history-validation integration, abort mapping, contract errors, and conditional 304 behavior.
./src/stores/useSessionStore.ts - Consumes validated complete transcripts and keeps cached messages visible while canonical history is loading.
package.json - Defines focused contracts/frontend tests, frontend typechecking, linting, and client build commands used for validation.

# ANALYSIS

Session histories are already validated through a dedicated asynchronous boundary, but the current policy keeps histories below 256 messages on the main thread and transfers larger histories to workers by cloning message chunks. The strict parser itself is inexpensive in a Node baseline (roughly 0.04 ms for 100 ordinary messages and 0.08 ms for 200), so a sub-second target for 100–200 messages should be comfortably attainable without weakening contract checks. The likely user-visible delay comes from avoidable orchestration overhead, worker startup/module loading, structured cloning of rich transcript objects, queued chunks, or a worker failure causing the entire history to be parsed again synchronously.

The implementation should optimize the real browser path rather than merely lowering the worker threshold. For medium histories, direct single-pass validation is expected to beat worker dispatch; for genuinely large histories, workers preserve UI responsiveness, but job granularity and pool behavior should avoid unnecessary cloning and queueing. Existing behavior that must remain stable includes exact error paths and earliest-message failure precedence, reference preservation in the returned validated envelope, abort handling, bounded reusable workers, and strict synchronous fallback when workers are unavailable.

Performance needs an explicit regression check using representative 100- and 200-message envelopes. A generous hard ceiling below one second avoids flaky microbenchmark assertions while still encoding the requested outcome; reporting median or best-of-several elapsed time separately will make meaningful regressions visible. Because Node does not model browser worker startup or structured-clone cost, focused unit timing should cover the medium-history fast path, while browser-capable validation or a production build should confirm the worker bundle remains loadable. No backend changes or VCS operations are required.

# PLAN

1. Optimize strict normalized-message and chunk validation to minimize allocations and repeated checks while preserving exact contract behavior.
2. Tune the client validation strategy so 100–200-message histories use the fastest path and large histories retain bounded off-main-thread validation without redundant work.
3. Add deterministic performance coverage and run focused integration, typecheck, lint, and client-build validation.

# GUIDELINES

- Preserve strict validation of every message; do not skip fields, trust server types without checks, or silently accept malformed histories.
- Preserve existing error codes, messages, paths, earliest global message-index failure precedence, and message object references on successful parsing.
- Optimize the common valid-message path with low allocation and one-pass checks; avoid constructing path strings or result arrays earlier than necessary.
- Keep medium histories, including 100 and 200 messages, on the path shown by measurement to be fastest and guarantee the validation promise resolves in under 1,000 ms in the focused regression test.
- Retain workers for histories large enough to benefit UI responsiveness, with bounded reusable concurrency and no more chunk jobs or structured-clone volume than justified by measurement.
- Preserve abort semantics for queued and active validations and strict fallback behavior when workers cannot be constructed or fail.
- Do not change session-history HTTP, caching, revision, store, or rendering semantics unless required to remove a proven validation bottleneck.
- Use the existing Node test runner and TypeScript tooling; avoid new dependencies and flaky ultra-tight timing thresholds.
- Do not use the prohibited `./tmp` or out-of-scope `./projects` directories, and do not perform VCS operations.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Optimize the shared strict normalized-message and session-history chunk validators for the common valid-message path without changing contract semantics.
  **Files:**
  ./shared/cloudcli-contracts.ts - Refactor the hot message/chunk validation path to reduce allocations, duplicate field checks, and unnecessary result construction while retaining reusable public parsers.
  ./shared/cloudcli-contracts.test.ts - Extend semantic and focused performance coverage for 100- and 200-message strict history validation, including malformed-message precedence and reference preservation.
  **Acceptance criteria:** Valid 100- and 200-message envelopes are strictly checked in one pass and complete comfortably below 1,000 ms in a deterministic focused regression; successful validation preserves original message references; malformed messages return the same error code, text, path, and earliest global index as before; and public parser types/behavior remain compatible.
  **Validation:** Run `node --import tsx --test shared/cloudcli-contracts.test.ts`; run a repeated representative benchmark for 100 and 200 messages and report elapsed results; run `npm run typecheck:frontend`; run scoped ESLint for touched shared files if supported by the repository configuration.
  **Summary:** Optimized `shared/cloudcli-contracts.ts` with an allocation-light normalized-message hot path, lazy failure-path construction, direct chunk reference return, and one-pass envelope message/metadata validation while preserving failure precedence and public results. Added deterministic 100/200-message repeated regression coverage in `shared/cloudcli-contracts.test.ts`, including array/message reference assertions. Contracts tests (9/9) and frontend typecheck passed. Repeated benchmark medians were 0.033576 ms/parse for 100 messages and 0.069759 ms/parse for 200 messages (1,000 parses/run). Scoped ESLint is unsupported for `shared/`: both touched files were ignored because no matching configuration was supplied.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Optimize client-side session-history validation strategy and worker orchestration using the improved shared validator so medium histories finish under one second and large histories avoid unnecessary transfer, queueing, and fallback work.
  **Files:**
  ./src/utils/sessionHistoryValidation.ts - Tune fast-path thresholds, chunk/job sizing, worker-pool completion and failure handling, and fallback behavior based on measured costs.
  ./src/utils/sessionHistoryValidation.worker.ts - Keep worker execution aligned with any optimized chunk request/response contract.
  ./src/utils/sessionHistoryValidation.test.ts - Add regression coverage for 100/200-message fast validation, large-history bounded worker use, deterministic failures, aborts, and non-duplicative fallback.
  ./src/utils/apiClient.ts - Preserve asynchronous validator integration and adjust only if required by the optimized validation contract.
  ./src/utils/apiClient.test.ts - Preserve and extend integration assertions if the parser invocation or error/abort behavior changes.
  **Acceptance criteria:** Client validation of representative 100- and 200-message histories resolves in under 1,000 ms without worker startup overhead; larger histories use a bounded reusable worker strategy with measured, justified task granularity; worker errors still produce strict validation results without unnecessary duplicate full-history parsing where safely avoidable; abort and earliest-failure behavior remain deterministic; and API client behavior is unchanged externally.
  **Validation:** Run `node --import tsx --test src/utils/sessionHistoryValidation.test.ts src/utils/apiClient.test.ts shared/cloudcli-contracts.test.ts`; run repeated 100/200-message timing checks plus a large-history worker-orchestration test; run `npm run typecheck:frontend`; run scoped ESLint for all touched frontend/shared files.
  **Summary:** Updated `src/utils/sessionHistoryValidation.ts` to retain the 256-message synchronous cutoff, cap worker jobs at two per worker while requiring approximately 256 messages per job, and recover from worker errors by synchronously validating only affected chunks instead of reparsing the full envelope. Added medium-history no-worker timing, coarse bounded chunking, and runtime-failure partial-fallback coverage in `src/utils/sessionHistoryValidation.test.ts`; worker and API contracts required no changes. Focused tests passed (31/31), frontend typecheck passed, and scoped ESLint passed. Repeated medians were 0.045452 ms/parse for 100 messages and 0.074434 ms/parse for 200 messages; a 2,048-message orchestration run completed in 1.878 ms with 2 reusable workers, 4 jobs, and maximum concurrency 2.

- [x] **ID:** 3 | **Batch:** 3
  **Task:** Reconcile the optimized validation path with the production client build and harden any performance or integration regression found without broadening scope.
  **Files:**
  ./shared/cloudcli-contracts.ts - Validate final shared parser performance and semantics after prior items.
  ./shared/cloudcli-contracts.test.ts - Validate final strict parser and timing regression coverage.
  ./src/utils/sessionHistoryValidation.ts - Validate final sync/worker selection and pool behavior.
  ./src/utils/sessionHistoryValidation.worker.ts - Confirm the worker remains included and loadable in the production client output.
  ./src/utils/sessionHistoryValidation.test.ts - Validate final client performance, failure, and abort coverage.
  ./src/utils/apiClient.ts - Confirm session-history requests still await strict validation before returning.
  ./src/utils/apiClient.test.ts - Confirm unconditional, conditional, abort, and contract-error integrations remain correct.
  package.json - Use existing focused test, typecheck, lint, and client-build commands without changing scripts unless a narrowly useful reusable validation command is justified.
  **Acceptance criteria:** Focused tests and frontend typechecking pass with no warnings; scoped lint passes; `npm run build:client` succeeds and emits a loadable session-history worker; repeated representative 100- and 200-message validation remains below 1,000 ms with reported timing; and no history API/cache/store behavior regresses.
  **Validation:** Run the focused contracts/session-history/API-client tests, `npm run typecheck:frontend`, scoped ESLint, and `npm run build:client`; inspect the generated worker artifact/reference; rerun the representative performance measurement after the production build and report results.
  **Summary:** Final production reconciliation required no source corrections. Focused contracts/session-history/API-client tests passed (31/31), including unconditional/conditional history validation, abort, contract-error, and 304 behavior; frontend typecheck passed without warnings; scoped ESLint passed for all applicable `src/utils` files. The repository ESLint configuration does not cover `shared/`, so direct shared-file lint reports only ignored-file warnings and cannot satisfy `--max-warnings 0`; this is the same configuration limitation recorded by Item 1. `npm run build:client` passed both bundle validators and emitted `dist/assets/sessionHistoryValidation.worker-BPxdJP1r.js` (1.83 kB); the worker passed `node --check`, contains its message handler, and the production API chunk references it. Post-build repeated medians were 0.038370 ms/parse for 100 messages and 0.078633 ms/parse for 200 messages (7 runs of 1,000 parses), well below 1,000 ms. The frontend reload skill rebuilt and reloaded successfully, and status reported running (supervisor PID 7, child PID 17898).

# CHANGELOG
- 2026-08-11 Item 1: Optimized strict shared message/history validation, added 100/200-message performance and reference-preservation coverage, and validated tests/typecheck plus repeated benchmark timings; scoped ESLint had no matching shared-file configuration.
- 2026-08-11 Item 2: Tuned large-history worker jobs to coarse bounded chunks, added per-failed-chunk strict fallback instead of duplicate full-history parsing, and added medium timing, orchestration, and runtime-failure regression coverage; focused tests, typecheck, and scoped ESLint passed.
- 2026-08-11 Item 3: Reconciled the optimized validator with the production client build without source corrections; focused tests, frontend typecheck, applicable scoped lint, worker emission/loadability checks, post-build timing, and frontend reload/status verification passed, with shared-file ESLint remaining outside repository configuration.
