# Remove Sidebar GitHub Badge

## CONTEXT

- The frontend sidebar header is implemented in `src/components/sidebar/view/subcomponents/SidebarHeader.tsx`.
- The desktop header renders the CloudCLI logo/title and action buttons, then renders `<GitHubStarBadge />` immediately below that header row and above the search tools.
- `GitHubStarBadge` is implemented in `src/components/sidebar/view/subcomponents/GitHubStarBadge.tsx`; it displays the GitHub icon, star prompt/count, and dismiss control.
- `GitHubStarBadge.tsx` is the only consumer of `src/hooks/useGitHubStars.ts`, and `SidebarHeader.tsx` is the only consumer of `GitHubStarBadge.tsx`.
- The requested change is frontend-only and does not touch backend code under `server/`.
- Project scripts include type checking, linting, testing, and building, but the user explicitly prohibited running `npm run build` and indicated that dependency installation will be handled manually later.

## ANALYSIS

- Removing the import and render site from `SidebarHeader.tsx` is sufficient to remove the visible badge from the top-left desktop sidebar.
- Because the badge component and its star-count hook have no other consumers, leaving them in place would create dead feature code. Removing those two now-unused files keeps the codebase aligned with the requested product behavior and prevents unused GitHub star-fetch/dismiss logic from lingering.
- The CloudCLI title/logo, sidebar action buttons, search controls, About-page GitHub link, plugin GitHub references, and project-cloning GitHub support are separate features and must remain unchanged.
- No layout replacement is needed: the search section already supplies its own top margin when present, so removing the badge should naturally collapse the space it occupied.
- Validation should avoid builds and package installation. Static source inspection/search is sufficient for this small deletion; a targeted typecheck or lint may only be attempted if dependencies are already available, but `npm run build` must never be run.

## PLAN

Remove the GitHub star badge from the expanded desktop sidebar header at its render site, then remove the now-unreferenced badge component and GitHub-star hook. Preserve all other sidebar branding, controls, spacing behavior, and GitHub-related functionality elsewhere in the application.

## GUIDELINES

- Work only within the frontend files needed for this feature removal and this plan file.
- Do not alter the CloudCLI logo/title block or desktop header action buttons.
- Do not remove GitHub functionality from project creation, settings/About, plugins, documentation, or backend services.
- Remove files only when they are confirmed to have no consumers after the sidebar render site is removed.
- Do not install dependencies.
- Do not run `npm run build`, `npm run build:client`, `npm run build:server`, or any script that invokes a build.
- Prefer non-build static validation. If a relevant validation command cannot run because dependencies are absent, report that rather than installing them.

## TODO

- [x] **ID:** 1 | **Batch:** 1
  **Task:** Remove the GitHub star badge from the desktop sidebar header and delete the badge-specific component and star-count hook once their references are gone.
  **Acceptance criteria:** The expanded desktop sidebar no longer renders the GitHub badge next to or below the CloudCLI title; `SidebarHeader.tsx` has no `GitHubStarBadge` import or render call; the unreferenced `GitHubStarBadge.tsx` and `useGitHubStars.ts` files are removed; all unrelated sidebar and GitHub features remain unchanged.
  **Validation:** Search `src/` to confirm there are no remaining `GitHubStarBadge` or `useGitHubStars` references; inspect the resulting `SidebarHeader.tsx` around the title/action/search boundary; do not run any build command or install dependencies. If dependencies are already present, a narrowly scoped non-build lint/typecheck may be used only if useful, but it is not required for this deletion.
  **Summary:** Removed the `GitHubStarBadge` import and render call from `src/components/sidebar/view/subcomponents/SidebarHeader.tsx`, then deleted the now-unreferenced `GitHubStarBadge.tsx` component and `src/hooks/useGitHubStars.ts` hook. The desktop header now transitions directly from the title/action row to the existing search section; unrelated sidebar and GitHub functionality was not changed.

## CHANGELOG

- **ID 1:** Removed the desktop sidebar GitHub star badge render/import and deleted the unreferenced `GitHubStarBadge.tsx` component and `src/hooks/useGitHubStars.ts` hook; confirmed no matching references remain under `src/`.
