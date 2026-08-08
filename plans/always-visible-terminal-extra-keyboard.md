# CONTEXT

## Files

./src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx - Existing terminal extra-keyboard component; it is currently mobile-only through `md:hidden`, renders as a fixed overlay, and owns no visibility state.
./src/components/shell/view/Shell.tsx - Renders the extra keyboard in both minimal and full terminal layouts and supplies connection, terminal, and modifier state.
./src/components/shell/utils/terminalShortcutKeys.ts - Defines the data-driven extra-keyboard keys and modifier behavior that the visibility change must preserve.
./src/components/shell/utils/terminalShortcutKeys.test.ts - Existing focused tests for shortcut sequences and modifiers; useful regression coverage but unrelated to presentation state.
package.json - Defines frontend TypeScript, ESLint, and production build validation commands.

# ANALYSIS

The existing terminal extra keyboard is already shared by full and minimal shell views, but its outer container has `md:hidden`, so it disappears at desktop widths. The request requires reversing that responsive limitation: the keyboard should render by default at every viewport size, while users retain an explicit control to collapse and restore it.

The visibility control belongs inside `TerminalShortcutsPanel` because both shell layouts use the component and the behavior is presentation-local. When expanded, a compact Hide control can sit alongside the existing keys. When collapsed, the key row must be removed while a small fixed Show control remains reachable in the same bottom area; otherwise users could not restore it. The state should initialize expanded on every component mount to satisfy “shown always” by default. No persisted preference is requested, and persistence could conflict with that default, so local storage is unnecessary.

The change must preserve terminal input, one-shot modifiers, clipboard handling, disconnected-state behavior, horizontal scrolling, fixed positioning, and both Shell render paths. The show/hide controls should be keyboard accessible and expose clear labels and expansion state. Focus-steal prevention should remain consistent so using the controls does not unnecessarily move focus away from xterm. Since this is a small React/Tailwind integration change without an existing DOM interaction test harness in this module, scoped TypeScript, ESLint, and production build checks provide the appropriate validation alongside the existing shortcut utility test.

# PLAN

1. Make the shared terminal extra keyboard responsive at all viewport sizes rather than hiding it from the `md` breakpoint upward.
2. Add component-local expanded state, an accessible Hide action in the open keyboard, and an always-reachable Show action in its collapsed state.
3. Preserve all existing shortcut, terminal-focus, connection, positioning, and modifier behavior in both full and minimal shell layouts.
4. Validate the focused frontend surface with existing shortcut tests, strict TypeScript, scoped linting, and a production client build.

# GUIDELINES

- Implement presentation and visibility behavior in ./src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx so both existing render sites inherit it without duplicated state.
- Remove only the responsive rule that makes the keyboard mobile-only; retain its fixed bottom positioning and horizontally scrollable compact layout.
- Initialize the keyboard expanded on mount and do not persist a hidden preference, because the requested default is always shown.
- When hidden, leave a compact Show button visible and operable; when shown, provide a clear Hide button without disabling it when the shell is disconnected.
- Give the toggle `type="button"`, meaningful `title` and `aria-label` text, and `aria-expanded` reflecting whether the keyboard is open.
- Retain pointer-down focus-steal prevention on the toggle controls and do not alter key sequences, socket messages, clipboard behavior, modifiers, or terminal protocol.
- Keep existing Tailwind/React/TypeScript conventions, add no dependency, avoid unrelated refactors, and perform no backend or VCS work.

# TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Make the existing terminal extra keyboard visible by default at every viewport width and add accessible controls that hide the key row and show it again in both full and minimal shell layouts.
  **Files:**
  ./src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx - Remove the mobile-only responsive restriction, own expanded state, render the open Hide control and collapsed Show control, and preserve all existing keyboard actions.
  ./src/components/shell/view/Shell.tsx - Confirm both existing render paths continue to use the shared panel without layout-specific duplication; modify only if integration requires it.
  ./src/components/shell/utils/terminalShortcutKeys.ts - Preserve the existing data-driven key and modifier contract while changing only panel presentation.
  ./src/components/shell/utils/terminalShortcutKeys.test.ts - Run existing shortcut behavior coverage to catch regressions in key handling.
  package.json - Use the repository's frontend validation commands.
  **Acceptance criteria:** The terminal extra keyboard is expanded by default and visible below, at, and above the `md` breakpoint in both full and minimal shell views; an accessible Hide button collapses the key row; while collapsed, an accessible Show button remains visible and restores the row; the toggle remains usable while disconnected; existing shortcut buttons, scrolling, paste, modifier state, focus-steal prevention, socket behavior, fixed bottom placement, and horizontal overflow behavior are unchanged.
  **Validation:** Run `node --import tsx --test src/components/shell/utils/terminalShortcutKeys.test.ts`; run `npx tsc --noEmit -p tsconfig.json`; run `npx eslint src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx src/components/shell/view/Shell.tsx`; run `npm run build:client`.
  **Summary:** Updated `TerminalShortcutsPanel.tsx` to remove the desktop visibility restriction, initialize component-local expanded state, and render accessible Hide/Show controls with pointer-down focus prevention that remain enabled while disconnected. Preserved the shared `Shell.tsx` render paths and all shortcut utility behavior without changes. All specified validation passed.

# CHANGELOG

- **Item 1:** Made the shared terminal extra keyboard visible at all viewport widths with local expanded state and accessible, focus-preserving Hide/Show controls; retained existing Shell integration and shortcut behavior, with all required checks passing.
