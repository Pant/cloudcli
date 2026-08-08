# CONTEXT

## Files

./vite.config.js - Defines Vite 8/Rolldown package-aware chunk groups, including a broad CodeMirror group whose `maxSize` splitting produced circular generated imports.
./package.json - Defines the production client build, bundle-budget validation, frontend typecheck, and installed CodeMirror/Vite dependency versions.
./scripts/validation/client-bundle-budget.mjs - Enforces the existing 100,000-byte gzip ceiling on every emitted client JavaScript artifact and must continue to pass.
./src/components/code-editor/utils/editorExtensions.ts - Statically imports CodeMirror core APIs and dynamically loads language, merge, and minimap capabilities whose production chunks must initialize correctly.
./src/components/code-editor/view/CodeEditor.tsx - Coordinates core editor extensions and asynchronous CodeMirror capabilities in the main code editor.
./src/components/code-editor/view/subcomponents/CodeEditorSurface.tsx - Mounts `@uiw/react-codemirror` with the shared extensions and theme.
./src/components/prd-editor/view/PrdEditorBody.tsx - Mounts a second CodeMirror surface with statically imported markdown, view, and theme packages.
plans/faster-build-bounded-chunks.md - Documents the prior bounded-chunk work, its 100,000-byte gzip contract, and the intended preservation of editor lazy boundaries.
dist/assets/codemirror-Bz-NSJ8l.js - Generated failing chunk reported by the browser; it imports `codemirror-Dgz1mMJ-.js` and evaluates a class inheritance path before the cycle is initialized.
dist/assets/codemirror-Dgz1mMJ-.js - Generated counterpart that imports back from `codemirror-Bz-NSJ8l.js`, proving a circular chunk dependency introduced by size-based splitting.

# ANALYSIS

The browser failure is present in the current production artifacts rather than being explained by duplicate package installations: `npm ls` resolves one deduplicated set of CodeMirror 6 core packages (`@codemirror/state` 6.7.1, `@codemirror/view` 6.43.8, `@codemirror/language` 6.12.4, and `@lezer/common` 1.5.2). The generated files expose the concrete fault: `codemirror-Bz-NSJ8l.js` imports symbols from `codemirror-Dgz1mMJ-.js`, while `codemirror-Dgz1mMJ-.js` imports symbols from `codemirror-Bz-NSJ8l.js`. That cross-chunk cycle allows an imported base class to remain `undefined` when the failing module evaluates, causing `Class extends value undefined`.

The cycle aligns with the broad CodeMirror package group in `vite.config.js`, where Rolldown is allowed to subdivide all `@codemirror`, `@lezer`, and supporting packages by a raw `maxSize` target. Splitting a tightly coupled library graph by size alone can cut through module initialization relationships and create unsafe chunk-level cycles. The fix should therefore be made at the bundling boundary, not by adding runtime guards or changing editor behavior. Prefer dependency-layer/package-aware groups that keep individual packages or coherent layers intact and produce an acyclic emitted import graph. Removing all CodeMirror grouping may restore runtime correctness but risks recreating the prior 101.84 kB gzip artifact, so the implementation must retain the hard 100,000-byte budget with safe boundaries rather than simply disabling splitting.

Validation needs to cover both constraints that can otherwise trade off against each other: no generated CodeMirror JavaScript chunk may participate in a circular static-import dependency, and every emitted JavaScript file must remain within the existing gzip budget. A targeted artifact-graph check should be automated in the validation pipeline so a successful build cannot silently reproduce this exact runtime hazard. Existing frontend typechecking and inspection of the editor entry/dynamic chunks should also pass. Frontend component source should remain unchanged unless configuration-only package boundaries prove insufficient.

# PLAN

1. Replace unsafe size-only subdivision of the tightly coupled CodeMirror graph with deterministic dependency/package-layer chunk boundaries that cannot emit the observed circular initialization path.
2. Add an artifact-level static import cycle validator for generated CodeMirror chunks and run it automatically after client builds alongside the gzip budget validator.
3. Rebuild and inspect the production client output, proving the reported chunk cycle is absent while editor lazy capabilities, frontend types, and the 100,000-byte gzip contract remain intact.

# GUIDELINES

- Treat the generated `codemirror-Bz-NSJ8l.js` ↔ `codemirror-Dgz1mMJ-.js` cycle as the primary defect; do not mask it with runtime fallbacks or exception handling.
- Keep source-level CodeMirror behavior and dynamic imports in ./src/components/code-editor/utils/editorExtensions.ts intact unless configuration-only chunking cannot solve the issue.
- Use Vite 8/Rolldown-supported configuration only; make chunk rules deterministic and based on coherent package/dependency boundaries rather than arbitrary cuts through a package.
- Preserve the existing hard maximum of 100,000 gzip bytes for every `dist/**/*.js` artifact, enforced by ./scripts/validation/client-bundle-budget.mjs.
- The new cycle check must parse generated static ESM imports sufficiently for Vite output, limit its failure contract to CodeMirror-related cycles, report the participating artifact chain clearly, and exit nonzero on a fixture reproducing a cycle.
- Integrate validation into `build:client` so normal full, release, desktop, and package builds cannot bypass it.
- Keep validation scoped to client artifacts and frontend typechecking; avoid unrelated frontend refactors and all backend changes.
- Do not modify generated `dist` files directly; they are validation output only.
- Work only inside the project directory `/home/dev/code/cloudcli-src`; do not use `/tmp` or create/read files outside the project. Any temporary validation fixture must live under `.manual-validation/` and be removed after use.
- Avoid VCS operations.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Fix production CodeMirror chunk initialization by introducing safe deterministic chunk boundaries, add automatic generated-artifact cycle detection, and validate the rebuilt client end to end.
  **Files:**
  ./vite.config.js - Replace the unsafe broad size-only CodeMirror split with coherent boundaries that prevent circular generated imports while retaining bounded artifacts.
  ./package.json - Add the CodeMirror chunk-graph validator to the normal client build and expose a direct validation command.
  ./scripts/validation/client-codemirror-chunks.mjs - Implement a focused generated static-import graph validator with actionable cycle diagnostics and a testable target-directory argument.
  ./scripts/validation/client-bundle-budget.mjs - Preserve and run the existing 100,000-byte gzip artifact contract; modify only if integration requires a narrowly compatible interface.
  ./src/components/code-editor/utils/editorExtensions.ts - Preserve the editor's core and dynamic CodeMirror capability imports; change only if safe bundler boundaries alone are insufficient.
  ./src/components/code-editor/view/CodeEditor.tsx - Preserve asynchronous language, merge, and minimap behavior while verifying emitted dependencies.
  ./src/components/code-editor/view/subcomponents/CodeEditorSurface.tsx - Preserve `@uiw/react-codemirror` mounting and theme behavior.
  ./src/components/prd-editor/view/PrdEditorBody.tsx - Preserve the PRD markdown editor's CodeMirror imports and behavior.
  plans/faster-build-bounded-chunks.md - Context for the existing gzip budget and prior chunking intent; do not edit.
  dist/assets/codemirror-Bz-NSJ8l.js - Contextual failing generated chunk from the current build; do not edit.
  dist/assets/codemirror-Dgz1mMJ-.js - Contextual generated cycle counterpart from the current build; do not edit.
  **Acceptance criteria:** `npm run build:client` succeeds; generated CodeMirror-related JavaScript chunks have no static-import cycle, including no equivalent of the reported `codemirror-Bz-NSJ8l.js` ↔ `codemirror-Dgz1mMJ-.js` path; every emitted JavaScript artifact remains at most 100,000 gzip bytes; a temporary isolated cyclic fixture makes the new validator fail nonzero with the cycle chain, while an acyclic fixture passes; the validator runs automatically in the normal client build; and code editor/PRD editor source behavior and lazy language/merge/minimap boundaries are preserved.
  **Validation:** Build with `npm run build:client`; run the direct CodeMirror chunk validator and existing bundle-budget validator; independently inspect generated CodeMirror static import edges and gzip sizes; exercise validator pass/failure paths with isolated temporary fixtures under `.manual-validation/` and remove them; run `npm run typecheck:frontend`; inspect emitted code-editor, PRD editor, language, merge, and minimap imports to confirm referenced artifacts exist and no circular CodeMirror path remains. Do not work in `/tmp` or anywhere outside `/home/dev/code/cloudcli-src`.
  **Summary:** Replaced the prior broad size-only CodeMirror split in `vite.config.js` with deterministic state/view/language/search/commands package-layer groups, preserving editor source and dynamic language/merge/minimap imports. Added `scripts/validation/client-codemirror-chunks.mjs` with recursive generated-JS static-import graph validation, CodeMirror-scoped cycle failures, actionable artifact chains, and a target-directory argument; exposed it as `validate:client-codemirror-chunks` and wired it into `build:client` before the unchanged 100,000-byte gzip validator. `npm run build:client`, direct validators, frontend typecheck, independent graph/gzip inspection, and acyclic/cyclic fixtures passed as required; the cyclic fixture reported `codemirror-a.js -> codemirror-b.js -> codemirror-a.js` nonzero. The build emitted 219 JS files with an acyclic CodeMirror dependency layering and a maximum gzip size of 82,757 bytes; temporary fixture files/directories were removed, while unrelated pre-existing `.manual-validation` contents were left untouched.

# CHANGELOG

- **Item 1:** Completed deterministic CodeMirror package-layer chunking and automatic static-import cycle validation; validated the client build, direct graph/budget checks, frontend types, independent emitted edges/gzip sizes, and cyclic/acyclic fixture behavior with cleanup (219 JS artifacts, maximum 82,757 bytes gzip).
