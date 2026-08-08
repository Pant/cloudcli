# Fix Search Tool Result Display

## CONTEXT

- The chat frontend is React 18 + TypeScript under `src/`, with the config-driven tool rendering system under `src/components/chat/tools/`.
- `src/components/chat/tools/configs/toolConfigs.ts` defines both input and result displays. `Grep` and `Glob` result titles currently compute their count exclusively from `result.toolUseResult.numFiles` or `result.toolUseResult.filenames`, and their result bodies exclusively render `result.toolUseResult.filenames`.
- `src/components/chat/tools/ToolRenderer.tsx` passes the full normalized tool result to the selected config, then renders search results with `FileListContent`.
- `src/components/chat/hooks/useChatMessages.ts` preserves both `content` and optional `toolUseResult` when converting normalized messages for the UI.
- Provider result shapes are not uniform. Claude history can attach SDK-specific `toolUseResult` metadata, and Cursor can attach provider-specific high-level result metadata. Codex attaches only textual `content` to tool results. OpenCode also attaches textual `content` from the tool state's output and does not populate `toolUseResult`.
- Consequently, successful `Grep`/`Glob` calls from providers without Claude-style `toolUseResult.filenames` reach the renderer with real data in `result.content`, while the current config deterministically reports `Found 0 files` and renders an empty list.
- Tool result content can be a string, JSON-serialized value, array, object, or provider-style textual summary. Search outputs commonly contain newline-separated paths, `Found N matches` summaries followed by file/line entries, or nested structured fields such as `filenames`, `files`, `matches`, and `results`.
- `FileListContent.tsx` renders a compact list of clickable paths and currently assumes an already-normalized array.
- Frontend tests use Node's built-in test runner with `tsx`; existing component tests use `renderToStaticMarkup`. The repository-wide `npm test` script targets backend tests, so frontend tests are run explicitly with `node --import tsx --test <files>`.
- The request is frontend-only; no backend files under `server/` need modification, so the backend module skill is not applicable.

## ANALYSIS

- The immediate defect is not an incorrect React count expression but an overly narrow result-shape assumption in the `Grep` and `Glob` configs. Fixing only `numFiles` would still leave the body empty, while fixing only the body would leave the title incorrect. Both must consume one shared normalized interpretation of the result.
- Provider adapters deliberately preserve provider-native result content. Duplicating search-output parsing in every backend provider would increase coupling and still fail for future providers or shape changes. The display layer is the correct compatibility boundary because it already selects specialized rendering based on tool semantics.
- A dedicated, pure search-result normalization helper should inspect structured `toolUseResult` metadata first, then structured or JSON-encoded `content`, then textual output. It should derive a deduplicated file list and a trustworthy count. When a provider supplies an explicit count larger than the visible/truncated file list, the title should preserve that count rather than silently replacing it with the rendered list length.
- Text parsing must be conservative. It should recognize absolute/relative file paths, newline-separated glob output, and grep lines with suffixes such as `:12:`, `: Line 12:`, or match text, while ignoring summary/status prose like `Found 100 matches`, truncation notices, and `No files found`. Paths should retain enough information for the existing file-open behavior.
- Structured parsing should tolerate malformed or evolving payloads without throwing. Candidate fields may be nested and may contain strings or objects with path-like properties. Duplicate matches from the same file should render one file entry.
- Empty results should continue to show zero and should not fabricate files. Unknown formats should degrade safely rather than crash the chat response.
- Although the user suspects other tools, the repository evidence identifies the same underlying class of bug specifically in the shared `Grep`/`Glob` result configuration. The fix should be implemented as reusable normalization rather than provider-specific conditionals, and tests should cover diverse shapes so future search-tool payloads benefit without broad speculative changes to unrelated tool renderers.
- Regression tests should exercise the pure normalizer across Claude-style metadata, OpenCode/Codex-style textual content, JSON content, grep match lines, explicit/truncated counts, duplicates, malformed values, and genuine empty output. A renderer/config-level assertion should verify that `Grep` and `Glob` titles and file props use the normalized result instead of the old `toolUseResult`-only path.

## PLAN

Introduce a defensive, provider-agnostic search-tool result normalizer in the frontend tool-rendering layer. Use it as the single source for `Grep` and `Glob` result titles and file-list content so structured metadata, structured/JSON content, and common textual outputs all display the actual file count and paths. Add focused regression tests for representative provider shapes, truncation/count semantics, malformed input, deduplication, and empty results, then validate frontend integration.

## GUIDELINES

- Keep the change in the frontend tool-rendering surface under `src/components/chat/tools/`; do not alter provider adapters or backend APIs for a display compatibility problem.
- Centralize result interpretation in one pure helper used by both `Grep` and `Glob`; do not duplicate parsing logic between their configs.
- Prefer reliable structured fields (`numFiles`, `filenames`, file/path properties, match/result arrays) before parsing textual content.
- Preserve an explicit provider count when it is valid, including when output is truncated and fewer file paths are available to render. Otherwise derive the count from the deduplicated file list.
- Deduplicate paths while preserving first-seen order. Keep path strings suitable for the existing `onFileOpen` callback.
- Text parsing must accept newline-separated paths and grep-style path/line/match records, while excluding summary, empty-result, truncation, and diagnostic prose.
- Parsing must never throw on malformed, cyclic, unexpectedly typed, or evolving payloads. Unknown/empty formats should safely return an empty list and zero count.
- Avoid broad changes to unrelated tools. The helper may be reusable for search-shaped results, but only `Grep` and `Glob` should be rewired unless direct test evidence shows another configured tool has the same contract.
- Follow existing TypeScript/import conventions. Keep UI wording and the compact `FileListContent` presentation unless a small empty-state improvement is necessary for correctness.
- Run frontend tests explicitly with `node --import tsx --test ...`; `npm test` does not include frontend tests. Also run typecheck and targeted lint for touched files, and run the client build if dependencies and the current workspace permit it.

## TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Implement a pure, provider-agnostic search tool result normalizer that extracts a deduplicated file list and accurate count from Claude-style `toolUseResult`, structured or JSON-encoded `content`, and common textual Grep/Glob output, with safe handling for malformed and empty values.
  **Acceptance criteria:** The helper returns correct files/count for `numFiles` plus `filenames`, nested `files`/`matches`/`results` structures, JSON strings, newline-separated glob paths, grep path-and-line output, duplicate file matches, explicit counts with truncated file lists, and genuine empty results; it does not throw on malformed or cyclic values; explicit valid counts are preserved when they exceed the visible file-list length.
  **Validation:** Add focused Node tests for all acceptance scenarios and run them with `node --import tsx --test <new-test-file>`; run targeted ESLint for the helper and test file and TypeScript typecheck as practical.
  **Summary:** Added `searchResultNormalizer.ts`, a defensive provider-agnostic normalizer that prioritizes Claude metadata, handles nested/JSON/structured and textual Grep/Glob output, deduplicates paths, preserves valid explicit totals, derives textual counts, and safely handles malformed/cyclic values. Added ten focused Node tests covering the acceptance scenarios. Validation passed with the focused Node test command, targeted ESLint, and `npm run typecheck`.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Rewire the `Grep` and `Glob` result configurations to consume the shared normalized search result for both their `Found N file(s)` titles and `FileListContent` props, and add renderer/config regression coverage demonstrating that content-only provider results no longer display zero files.
  **Acceptance criteria:** Both tools display the normalized count and file paths for results that have no `toolUseResult`; existing Claude-style metadata still displays correctly; zero-result wording remains grammatically correct; no duplicate parser logic remains in the two configs; unrelated tool rendering behavior is unchanged.
  **Validation:** Add focused config or static-render tests covering Grep and Glob with metadata-backed, content-only, and empty results; run the new tests plus the Item 1 normalizer tests, targeted ESLint for touched frontend files, `npm run typecheck`, and `npm run build:client` if the workspace permits.
  **Summary:** Rewired the shared Grep/Glob result config in `toolConfigs.ts` to use `normalizeSearchToolResult` for both titles and file-list props, preserving metadata behavior and zero-result wording without duplicating parser logic. Added `toolConfigs.test.ts` coverage for both tools with Claude metadata, content-only output, and empty results. Validation passed with focused config plus normalizer tests, targeted ESLint, `npm run typecheck`, and `npm run build:client`.

## CHANGELOG

- **Item 1:** Added the pure search result normalizer and focused coverage for metadata, nested and JSON content, glob paths, grep records, deduplication, explicit/truncated counts, empty results, and malformed/cyclic payloads. Validation passed: `node --import tsx --test src/components/chat/tools/searchResultNormalizer.test.ts`, targeted ESLint, and `npm run typecheck`.

- **Item 2:** Rewired Grep and Glob titles and file-list props to the shared normalizer and added focused metadata/content-only/empty config coverage. Validation passed: focused config and normalizer tests, targeted ESLint, `npm run typecheck`, and `npm run build:client`.
