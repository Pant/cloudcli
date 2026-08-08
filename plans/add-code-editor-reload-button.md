# Add Code Editor Reload Button

## CONTEXT

The file viewer/code editor is a React and TypeScript component built on CodeMirror. Text file content is loaded by `useCodeEditorDocument`, while `CodeEditor` connects that document state to a compact icon-button header containing preview, settings, download, save, fullscreen, and close actions. The initial loader is currently private to an effect, so there is no callable reload action. The project uses `lucide-react`, i18next locale JSON files, strict TypeScript, ESLint, Vite builds, and focused Node tests via `node:test`.

### FILES

./src/components/code-editor/hooks/useCodeEditorDocument.ts - Owns file reads and must expose a reusable reload action with safe loading and error-state behavior.
./src/components/code-editor/view/CodeEditor.tsx - Wires document actions and translated labels into the editor header.
./src/components/code-editor/view/subcomponents/CodeEditorHeader.tsx - Renders the action buttons next to Save and must render the new reload control and state.
./src/i18n/locales/en/codeEditor.json - Defines the canonical English reload action labels.
./src/i18n/locales/de/codeEditor.json - Defines German code-editor action labels and needs reload strings.
./src/i18n/locales/fr/codeEditor.json - Defines French code-editor action labels and needs reload strings.
./src/i18n/locales/it/codeEditor.json - Defines Italian code-editor action labels and needs reload strings.
./src/i18n/locales/ja/codeEditor.json - Defines Japanese code-editor action labels and needs reload strings.
./src/i18n/locales/ko/codeEditor.json - Defines Korean code-editor action labels and needs reload strings.
./src/i18n/locales/ru/codeEditor.json - Defines Russian code-editor action labels and needs reload strings.
./src/i18n/locales/tr/codeEditor.json - Defines Turkish code-editor action labels and needs reload strings.
./src/i18n/locales/zh-CN/codeEditor.json - Defines Simplified Chinese code-editor action labels and needs reload strings.
./src/i18n/locales/zh-TW/codeEditor.json - Defines Traditional Chinese code-editor action labels and needs reload strings.
./package.json - Provides typecheck, ESLint, focused test, and client build commands used for validation.
src/components/code-editor/utils/editorExtensions.test.ts - Shows the local focused frontend test convention using Node's built-in test runner.

## ANALYSIS

The requested control belongs in `CodeEditorHeader`, next to the existing Save and related file actions. A real reload must re-read the selected file through the same `api.readFile` path used on initial load and replace the current editor buffer with the latest disk content. Refactoring the initial async loader into a stable callback is preferable to duplicating network/error logic, and the hook should expose both the callback and a reload/loading state usable to disable the button and animate the refresh icon.

Reloading necessarily discards unsaved editor changes because the user explicitly requests the disk version. No confirmation was requested, and adding one would make a compact toolbar action inconsistent with the stated requirement. The action should clear stale save errors/success state, guard against repeated clicks while loading, preserve existing preview/binary handling, and continue to use the existing full loading state only for initial/file-change loads rather than replacing the whole editor during a manual refresh. The toolbar title should be localized, with a distinct loading label for accessibility. Focused regression coverage should verify that the hook exposes reload behavior and the header wires a disabled, stateful reload button adjacent to Save; typecheck, targeted lint, and the client build provide integration validation.

## PLAN

1. Refactor the document loader into a reusable reload action that fetches the current text file from disk, safely updates the buffer and status state, and preserves existing initial, diff, preview, and binary behavior.
2. Add a localized, stateful reload icon button beside Save in the code-editor header and connect it through `CodeEditor`.
3. Add focused regression coverage and run scoped frontend validation.

## GUIDELINES

- Keep the change within the frontend code-editor feature; no backend or API contract changes are needed.
- Reuse `api.readFile` and the existing file/project identifiers in ./src/components/code-editor/hooks/useCodeEditorDocument.ts rather than introducing a second loading path.
- Manual reload replaces unsaved editor content with the latest disk content. Do not add a confirmation dialog unless existing code conventions require one.
- Do not cover the editor with the initial loading screen during a manual reload; expose a distinct reloading state for the toolbar button.
- Disable the reload button while a reload or save is active, disable Save while a reload is active, and use the Lucide refresh icon with an animated state while refreshing.
- Preserve previewable media and generic binary behavior. The visible header button is for editable text/code files, which use the standard editor header.
- Add `actions.reload` and `actions.reloading` to every code-editor locale file so the new title does not depend on a missing-key fallback.
- Avoid unrelated UI refactors, API changes, or VCS operations. Keep validation scoped to the affected frontend area.

## TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Implement the complete code-editor reload action: expose a reusable manual disk reload from the document hook, wire it through `CodeEditor`, render a localized stateful reload button adjacent to Save in the header, add all locale strings, and add focused regression coverage for the behavior and wiring.
  **Files:**
  ./src/components/code-editor/hooks/useCodeEditorDocument.ts - Refactor the existing loader and expose manual reload/reloading state without changing initial, diff, preview, binary, save, or download semantics.
  ./src/components/code-editor/view/CodeEditor.tsx - Pass the new action/state and translations from the document hook to the header.
  ./src/components/code-editor/view/subcomponents/CodeEditorHeader.tsx - Add the refresh icon button next to Save with disabled and animated loading behavior.
  ./src/i18n/locales/en/codeEditor.json - Add English reload and reloading labels.
  ./src/i18n/locales/de/codeEditor.json - Add German reload and reloading labels.
  ./src/i18n/locales/fr/codeEditor.json - Add French reload and reloading labels.
  ./src/i18n/locales/it/codeEditor.json - Add Italian reload and reloading labels.
  ./src/i18n/locales/ja/codeEditor.json - Add Japanese reload and reloading labels.
  ./src/i18n/locales/ko/codeEditor.json - Add Korean reload and reloading labels.
  ./src/i18n/locales/ru/codeEditor.json - Add Russian reload and reloading labels.
  ./src/i18n/locales/tr/codeEditor.json - Add Turkish reload and reloading labels.
  ./src/i18n/locales/zh-CN/codeEditor.json - Add Simplified Chinese reload and reloading labels.
  ./src/i18n/locales/zh-TW/codeEditor.json - Add Traditional Chinese reload and reloading labels.
  ./package.json - Use existing frontend validation commands.
  src/components/code-editor/utils/editorExtensions.test.ts - Context for the focused Node test style; do not edit unless genuinely useful.
  **Acceptance criteria:** The normal text/code editor header shows a reload icon button immediately next to Save; clicking it re-reads the currently selected file through the existing API and replaces the editor buffer with current disk content; the button is disabled and visibly animated while reloading, duplicate reloads are prevented, Save cannot race an active reload, stale save feedback is cleared, failures surface through the existing error area, and initial loading, file switching, diff snapshots, previewable media, binary files, saving, downloading, fullscreen, and closing continue to behave as before. All supported locales contain reload labels.
  **Validation:** Add focused frontend tests that exercise or statically verify reusable reload behavior and header wiring/state, following the repository's `node:test` convention. Run those focused tests, `npm run typecheck`, targeted ESLint for all touched TypeScript/TSX files, JSON parsing for all changed locale files, and `npm run build:client`.
  **Summary:** Refactored `useCodeEditorDocument.ts` around a shared initial/manual read callback, exposing guarded `handleReload`/`reloading` state, clearing stale save feedback, reporting reload failures in the existing error area, and preventing save/reload races. Wired the action through `CodeEditor.tsx`, added an adjacent animated `RefreshCw` button in `CodeEditorHeader.tsx`, added labels in all 10 locales, and added a focused Node source-regression test. All requested validation passed.

## CHANGELOG

- **Item 1:** Added reusable guarded disk reload behavior, header wiring and animated localized reload control, all locale labels, and focused regression tests. Validation passed: focused Node tests, typecheck, targeted ESLint, locale JSON parsing, and client production build.
