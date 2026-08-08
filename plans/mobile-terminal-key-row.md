# CONTEXT

## Files

./src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx - Existing Android-sized mobile-only terminal toolbar that sends escape sequences, supports paste and scrolling, and currently has incomplete modifier behavior.
./src/components/shell/view/Shell.tsx - Shell composition root that renders the terminal and the mobile shortcut toolbar in both full and minimal layouts.
./src/components/shell/hooks/useShellRuntime.ts - Runtime coordinator that owns terminal and WebSocket refs and forwards terminal configuration to the terminal hook.
./src/components/shell/hooks/useShellTerminal.ts - Xterm initialization and input pipeline where Gboard-generated input is forwarded to the PTY and where one-shot mobile modifiers can be applied reliably.
./src/components/shell/types/types.ts - Shared shell runtime option and result types that must describe any modifier bridge added between the toolbar and xterm input pipeline.
./src/components/shell/utils/terminalShortcutKeys.ts - Planned pure definitions and transformations for mobile terminal keys, ANSI sequences, and one-shot modifiers.
./src/components/shell/utils/terminalShortcutKeys.test.ts - Planned focused node:test coverage for key sequences and modifier transformations.
src/components/shell/utils/socket.ts - Existing guarded WebSocket sender used by both xterm input and the mobile toolbar.
src/components/shell/constants/constants.test.ts - Frontend unit-test example using node:test and strict assertions.
package.json - Defines frontend typecheck, lint, and build commands; the default test script only discovers backend tests.
tsconfig.json - Strict frontend TypeScript configuration covering src and using bundler module resolution.

# ANALYSIS

The shell already renders a horizontally scrollable `md:hidden` key row, so this task is an extension and correction rather than a new surface. It currently includes paste, Escape, Tab, Shift+Tab, Ctrl, Alt, arrows, Ctrl+C, and scroll-to-bottom. However, Ctrl and Alt are local toolbar states and can only modify one-character toolbar keys; no such printable keys exist in the toolbar, so they cannot modify the next character entered through Gboard and are effectively nonfunctional. There is also no standalone Shift modifier and common hardware-only terminal navigation keys are missing.

The mobile row should cover keys absent or awkward on a standard Android Gboard layout without attempting to duplicate the full alphanumeric keyboard. A practical terminal-focused set is: Escape, Tab, Shift, Ctrl, Alt, arrows, Home, End, Page Up, Page Down, Insert, Delete, Enter, Backspace, F1-F12, and a small set of high-value direct control commands such as Ctrl+C, Ctrl+D, Ctrl+Z, and Ctrl+L. Paste and scroll-to-bottom remain useful actions. The toolbar stays mobile-only, single-row, horizontally scrollable, compact, touch-friendly, and usable in both shell layouts.

One-shot Shift/Ctrl/Alt must affect the next Gboard/xterm input as users expect, not only toolbar-generated sequences. This requires lifting modifier state to `Shell`, passing it through the runtime into `useShellTerminal`, transforming the next xterm `onData` payload, and clearing consumed modifiers. Toolbar keys should use the same pure transformation rules so modifier behavior is consistent. ANSI navigation sequences must be explicit and deterministic; modified CSI keys should use standard xterm modifier parameters where applicable. Unsupported or multi-character paste/composition input should not be destructively rewritten; modifiers should be consumed only by an eligible key/input action.

Pure key and modifier logic should be extracted from the React component so it can receive focused `node:test` coverage without adding a browser test framework. Validation should include those focused tests, frontend typechecking, scoped linting, and a production client build because Tailwind classes and TSX integration are involved. No backend or VCS work is required.

# PLAN

1. Define a reusable mobile terminal key model with standard ANSI/control sequences and pure one-shot Shift/Ctrl/Alt transformations, including tests for ordinary characters, control characters, Alt prefixes, shifted ASCII, navigation keys, and ineligible multi-character input.
2. Expand the existing mobile-only terminal row with the missing Android keyboard substitutes, accessible labels, compact horizontal scrolling, visible modifier state, and retained paste/scroll actions.
3. Bridge toolbar modifier state into xterm's input handler so the next eligible key typed on Gboard is transformed and modifiers reset consistently in full and minimal shell layouts.
4. Include F1-F12 using their standard xterm sequences, including modified function-key forms.
5. Validate the focused behavior and frontend integration with unit tests, TypeScript, scoped ESLint, and the production client build.

# GUIDELINES

- Keep the toolbar `md:hidden`; desktop shell behavior must not change.
- Preserve one compact, horizontally scrollable row rather than wrapping keys or permanently reducing terminal height by multiple rows.
- Treat Shift, Ctrl, and Alt as one-shot toggles with clear active styling; combinations may be active together and must reset after an eligible input is sent.
- Apply active modifiers to both toolbar key actions and the next eligible single key received through xterm from Gboard.
- Do not rewrite paste, IME composition, or other multi-character text as though it were one keypress; preserve the payload and do not consume modifiers unless the action is eligible.
- Use standard terminal sequences: Escape `ESC`, Tab `HT`, Shift+Tab `ESC [ Z`, arrows `ESC [ A/B/C/D`, Home/End `ESC [ H/F`, Insert/Delete `ESC [ 2~/3~`, Page Up/Down `ESC [ 5~/6~`, Enter `CR`, and Backspace `DEL`.
- Use standard xterm function-key sequences: F1-F4 `ESC O P/Q/R/S` and F5-F12 `ESC [ 15~/17~/18~/19~/20~/21~/23~/24~`; use standard CSI modifier parameters when a toolbar modifier is active.
- Retain direct Ctrl+C and add high-value direct Ctrl+D, Ctrl+Z, and Ctrl+L buttons for interrupt, EOF, suspend, and clear-screen workflows.
- Every icon-only key/action needs an English fallback `title` and `aria-label`; avoid requiring locale updates for this focused change unless existing translations already cover the label.
- Use ./src/components/shell/utils/terminalShortcutKeys.ts for pure key/modifier logic and keep React state/rendering in ./src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx.
- Follow strict TypeScript and existing Tailwind/React conventions; avoid dependencies, backend changes, unrelated refactors, and VCS operations.
- Frontend tests are not included by `npm test`; run the focused file directly with Node's tsx loader.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Implement the complete Android/Gboard mobile terminal key row, including tested ANSI key definitions and one-shot Shift/Ctrl/Alt behavior that applies to the next eligible toolbar or xterm/Gboard input.
  **Files:**
  ./src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx - Expand and render the mobile key row, expose controlled modifier state, send key actions, and preserve paste/scroll behavior.
  ./src/components/shell/view/Shell.tsx - Own one-shot mobile modifier state and pass it to both toolbar instances and the shell runtime.
  ./src/components/shell/hooks/useShellRuntime.ts - Forward mobile modifier input configuration from the shell component into xterm initialization.
  ./src/components/shell/hooks/useShellTerminal.ts - Transform the next eligible xterm/Gboard input with active mobile modifiers and clear consumed state.
  ./src/components/shell/types/types.ts - Add the shared modifier state and callback types needed by the shell runtime boundary.
  ./src/components/shell/utils/terminalShortcutKeys.ts - Add pure shortcut definitions, ANSI/control sequences, accessibility metadata, and modifier transformation helpers.
  ./src/components/shell/utils/terminalShortcutKeys.test.ts - Add focused unit tests for key sequences, modifier combinations, modifier consumption, and multi-character input preservation.
  src/components/shell/utils/socket.ts - Use the existing guarded WebSocket input sender without changing its protocol.
  src/components/shell/constants/constants.test.ts - Follow the repository's node:test style for frontend utility tests.
  package.json - Use the existing typecheck, lint, and client-build tooling for validation.
  **Acceptance criteria:** On screens below the `md` breakpoint, both full and minimal shell views show one compact horizontally scrollable row containing Paste, Esc, Tab, Shift, Ctrl, Alt, Up/Down/Left/Right, Home, End, PgUp, PgDn, Ins, Del, Enter, Backspace, Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, and scroll-to-bottom; every key emits the correct standard terminal sequence while disconnected controls remain disabled; Shift/Ctrl/Alt show active state, may be combined, affect the next eligible toolbar key or single Gboard/xterm key, then reset; multi-character paste/composition payloads are preserved without consuming modifiers; icon-only controls have accessible labels; desktop behavior and the shell WebSocket protocol remain unchanged.
  **Validation:** Implement and run `node --import tsx --test src/components/shell/utils/terminalShortcutKeys.test.ts`; run `npx tsc --noEmit -p tsconfig.json`; run `npx eslint src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx src/components/shell/view/Shell.tsx src/components/shell/hooks/useShellRuntime.ts src/components/shell/hooks/useShellTerminal.ts src/components/shell/types/types.ts src/components/shell/utils/terminalShortcutKeys.ts src/components/shell/utils/terminalShortcutKeys.test.ts`; run `npm run build:client`.
  **Summary:** Added pure mobile terminal shortcut definitions and modifier transforms with focused node:test coverage; expanded the controlled mobile toolbar in both shell layouts; bridged one-shot Shift/Ctrl/Alt state through Shell/useShellRuntime into xterm input while preserving multi-character input and the existing guarded socket protocol. Validation passed: focused tests, TypeScript, scoped ESLint, and client build.

- [x] **ID:** 2 | **Batch:** 2
  **Task:** Complete the Gboard replacement row by adding F1-F12 with standard xterm sequences and modified function-key handling.
  **Files:**
  ./src/components/shell/utils/terminalShortcutKeys.ts - Extend the shared shortcut model and ordered key list with F1-F12 standard and modified sequences.
  ./src/components/shell/utils/terminalShortcutKeys.test.ts - Cover every unmodified function-key sequence and representative modified F-key sequences.
  ./src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx - Confirm the data-driven row renders the new function keys accessibly without layout regression; change only if required.
  package.json - Use existing validation tooling.
  **Acceptance criteria:** The mobile row includes F1 through F12 in its horizontal sequence; F1-F4 emit standard SS3 sequences unmodified, F5-F12 emit standard CSI tilde sequences, active Shift/Ctrl/Alt produce standard modified CSI sequences and are consumed, all function buttons are disabled while disconnected, and the single-row mobile-only behavior remains unchanged.
  **Validation:** Extend and run `node --import tsx --test src/components/shell/utils/terminalShortcutKeys.test.ts`; run `npx tsc --noEmit -p tsconfig.json`; run `npx eslint src/components/shell/utils/terminalShortcutKeys.ts src/components/shell/utils/terminalShortcutKeys.test.ts src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx`; run `npm run build:client`.
  **Summary:** Extended the shared ordered shortcut list with F1-F12, using SS3 for unmodified F1-F4 and CSI tilde codes for F5-F12 while reusing standard CSI modifier parameters for one-shot Shift/Ctrl/Alt. Added tests for all unmodified sequences, ordering, and representative modified F-key combinations. The existing data-driven panel required no change and retains accessible labels, disconnected disabling, and its mobile-only single-row horizontal layout. All required validation passed.

# CHANGELOG

- **Item 1:** Implemented the complete mobile terminal key row, shared one-shot modifier state for toolbar and Gboard/xterm input, standard ANSI/control transformations, accessibility labels, and focused tests; all required validation passed.
- **Item 2:** Added F1-F12 to the shared mobile shortcut row with standard SS3/CSI tilde sequences and standard modified CSI forms; expanded focused coverage for all unmodified and representative modified function keys; all required validation passed.
