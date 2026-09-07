<div align="center">
  <img src="public/logo.svg" alt="CloudCLI" width="64" height="64">
  <h1>CloudCLI</h1>
  <p>A responsive web and desktop interface for Claude Code, Cursor CLI, Codex, and OpenCode.</p>
  <p>Work with agent sessions, source files, Git, terminals, browser automation, and project tools from desktop or mobile.</p>
</div>

<p align="center">
  <a href="https://cloudcli.ai">CloudCLI Cloud</a> ·
  <a href="https://cloudcli.ai/docs">Documentation</a> ·
  <a href="https://discord.gg/buxwujPNRE">Discord</a> ·
  <a href="https://github.com/siteboon/claudecodeui/issues">Issues</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://cloudcli.ai"><img src="https://img.shields.io/badge/CloudCLI_Cloud-Try_Now-0066FF?style=for-the-badge" alt="CloudCLI Cloud"></a>
  <a href="https://discord.gg/buxwujPNRE"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord"></a>
</p>

<div align="right"><i><b>English</b> · <a href="./README.ru.md">Русский</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.tr.md">Türkçe</a></i></div>

> The English README is the current project-state overview. Translations may follow the upstream release cadence.

## Screenshots

<div align="center">
<table>
<tr>
<td align="center"><b>Desktop</b><br><img src="public/screenshots/desktop-main.png" alt="CloudCLI desktop interface" width="400"></td>
<td align="center"><b>Mobile</b><br><img src="public/screenshots/mobile-chat.png" alt="CloudCLI mobile interface" width="250"></td>
</tr>
<tr>
<td align="center" colspan="2"><b>Agent selection</b><br><img src="public/screenshots/cli-selection.png" alt="Agent selection" width="400"></td>
</tr>
</table>
</div>

## What CloudCLI provides

- **Multi-agent sessions** — Start, resume, and monitor Claude Code, Cursor CLI, Codex, and OpenCode conversations from one project-oriented UI.
- **Reliable realtime chat** — Stream run events over WebSockets, reconcile reconnects, recover session history, queue sends, and retain local state through refreshes.
- **Responsive application shell** — Navigate projects and sessions with desktop or mobile sidebars, deep links, tabs, and a global command palette.
- **Workspace tools** — Browse, search, upload, edit, diff, and recover files without leaving the application.
- **Git workflows** — Inspect changes and history; stage, commit, branch, synchronize remotes, and manage worktrees.
- **Integrated terminal** — Open project/session-aware xterm shells with desktop and mobile controls.
- **Browser automation monitor** — Install the runtime and inspect, stop, or remove agent-created browser sessions.
- **Settings and integrations** — Configure providers, MCP servers, skills, plugins, notifications, appearance, and project behavior.
- **Extensible plugins** — Add project tabs with frontend UI and optional Node.js backend services.
- **PWA support** — Install CloudCLI, receive safe update prompts and web push, and load the cached application shell offline.
- **Electron companion** — Use native macOS and Windows windows, tabs, tray/menu integration, local-server discovery, remote environments, deep links, and native notifications.
- **HTTP API** — Use authenticated APIs for projects, sessions, files, Git, settings, integrations, and agent execution; available models are exposed at runtime.

CloudCLI uses the selected agent's own authentication and model access. It provides the interface and execution environment, not an AI subscription.

## Quick start

### CloudCLI Cloud

[CloudCLI Cloud](https://cloudcli.ai) provides a managed, containerized environment accessible from browsers, mobile devices, the desktop companion, APIs, and supported IDE workflows. No local server setup is required.

### Self-host with npm

Requirements:

- Node.js 22 or later
- At least one supported agent CLI installed and authenticated

Run without a permanent install:

```sh
npx @cloudcli-ai/cloudcli
```

Or install the package globally:

```sh
npm install --global @cloudcli-ai/cloudcli
cloudcli
```

Open `http://localhost:3001`. The server hosts the production frontend, Express API, and WebSocket endpoints. Use `cloudcli status` to inspect configuration and data locations.

For server binding, ports, databases, and integration variables, start from [`.env.example`](.env.example). Restrict `HOST` to `127.0.0.1` unless remote access is intentionally protected.

### Docker sandbox (experimental)

Run a supported agent in an isolated Docker Sandbox environment with the [`sbx` CLI](https://docs.docker.com/ai/sandboxes/get-started/):

```sh
npx @cloudcli-ai/cloudcli@latest sandbox ~/my-project
```

The sandbox flow supports Claude Code and Codex. See [`docker/`](docker/) for setup and advanced options.

### Desktop companion

The optional Electron companion opens CloudCLI Cloud environments or a local CloudCLI server, and can discover or start the local server for you.

- [Download for macOS](https://cloudcli.ai/download/macos)
- [Download for Windows](https://cloudcli.ai/download/windows)
- [Download page](https://cloudcli.ai/download)
- [GitHub Releases and checksums](https://github.com/siteboon/claudecodeui/releases)

Packaged desktop targets are macOS DMG and Windows NSIS. The `cloudcli://` protocol supports desktop authentication callbacks.

## Choose a deployment

| | npm self-host | Docker Sandbox | CloudCLI Cloud |
|---|---|---|---|
| Best for | Local projects on your machine | Isolated local agent work | Managed remote environments |
| Access | Browser or desktop companion | Browser or desktop companion | Browser, mobile, desktop, APIs |
| Host stays online | Yes | Yes | No |
| Isolation | Your host account | Docker Sandbox microVM | Managed cloud environment |
| Setup | `npx @cloudcli-ai/cloudcli` | `cloudcli sandbox` | No local setup |
| Core workspace UI | Yes | Yes | Yes |

## Local development

```sh
git clone https://github.com/siteboon/claudecodeui.git
cd claudecodeui
npm install
npm run dev
```

`npm run dev` starts the Express backend and Vite frontend together. By default the API uses port `3001` and Vite uses `5173`.

Useful scripts:

| Command | Purpose |
|---|---|
| `npm run dev` | Run backend and frontend development servers. |
| `npm run build` | Build production client and server output. |
| `npm run server` | Run the compiled server. |
| `npm run client` | Run only Vite. |
| `npm run desktop:dev` | Open Electron against the Vite development URL. |
| `npm run desktop:pack` | Build and create an unpacked desktop package. |
| `npm run typecheck` | Type-check frontend and backend. |
| `npm run lint` | Lint `src/` and `server/` with zero warnings. |
| `npm test` | Run the aggregate test and validation suite. |
| `npm run test:backend` | Run backend tests. |
| `npm run test:frontend` | Run frontend tests. |
| `npm run test:contracts` | Run shared contract tests. |
| `npm run validate:pwa` | Validate PWA assets, lifecycle, notifications, metadata, fonts, and built output. |

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. It covers prerequisites, project structure, Conventional Commits, focused changes, and the release workflow. Release history is maintained in [`CHANGELOG.md`](CHANGELOG.md).

## Architecture guide

CloudCLI is a React 19/Vite application backed by Express, SQLite, and WebSockets. The same server delivers APIs and production assets. Shared contracts live in `shared/`; provider execution and host integrations are isolated in backend modules; Electron is a separate privileged shell around local or hosted CloudCLI URLs.

The [`codemaps/`](codemaps/) directory is the fastest detailed index:

- [`frontend-app-shell-navigation.md`](codemaps/frontend-app-shell-navigation.md) — bootstrap, routes, responsive shell, projects, sessions, tabs, and command palette.
- [`frontend-chat-session-state.md`](codemaps/frontend-chat-session-state.md) — messages, caches, queued sends, streaming, and reconciliation.
- [`frontend-workspace-tools.md`](codemaps/frontend-workspace-tools.md) — files, editor recovery, Git, terminal, and browser monitoring.
- [`frontend-settings-plugins-onboarding.md`](codemaps/frontend-settings-plugins-onboarding.md) — providers, MCP, skills, plugins, settings, and onboarding.
- [`frontend-pwa-mobile-push.md`](codemaps/frontend-pwa-mobile-push.md) — installation, caching, updates, web push, and mobile behavior.
- [`backend-foundations-api-auth.md`](codemaps/backend-foundations-api-auth.md) — server composition, authentication, API/static delivery, and shared utilities.
- [`backend-agent-provider-cli.md`](codemaps/backend-agent-provider-cli.md) — provider contracts, execution, CLI dispatch, and sandboxing.
- [`backend-realtime-websocket-sessions.md`](codemaps/backend-realtime-websocket-sessions.md) — subscriptions, sequence/replay, session events, and delivery.
- [`backend-workspaces-files-git.md`](codemaps/backend-workspaces-files-git.md) — path safety, project discovery, file operations, Git, and worktrees.
- [`desktop-electron-companion.md`](codemaps/desktop-electron-companion.md) — Electron windows, tabs, local server, security bridge, notifications, and packaging.

## Security

CloudCLI can execute agent tools, shell commands, Git operations, browser automation, and file mutations with the permissions of its server process. Treat access to a deployment as access to its configured workspaces and credentials.

- Bind locally or place remote deployments behind authenticated TLS ingress.
- Enable agent tools selectively and review provider permission settings.
- Never commit API keys, JWT secrets, databases, session state, or generated credentials.
- Protect the Docker socket and management integrations as host-control capabilities.
- Keep Electron's context-isolated preload bridge and origin restrictions intact.
- Review [`.env.example`](.env.example) and deployment documentation before exposing integrations.

## Plugins

Install plugins from **Settings → Plugins**, or build one from the [plugin starter](https://github.com/cloudcli-ai/cloudcli-plugin-starter). Plugins can contribute project tabs, frontend rendering, live context updates, RPC, and optional backend services. See the [plugin documentation](https://cloudcli.ai/docs/plugin-overview).

Community examples include [Web Terminal](https://github.com/cloudcli-ai/cloudcli-plugin-terminal), [Claude Watch](https://github.com/satsuki19980613/cloudcli-claude-watch), [Scheduler](https://github.com/grostim/cloudcli-cron), and [PRISM](https://github.com/jakeefr/cloudcli-plugin-prism).

## Community and support

- [Documentation](https://cloudcli.ai/docs)
- [Discord](https://discord.gg/buxwujPNRE)
- [GitHub Issues](https://github.com/siteboon/claudecodeui/issues)
- [Contributing guide](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

CloudCLI is licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`), including the additional Section 7 terms in [`LICENSE`](LICENSE).

You may use, modify, and distribute the software under that license. If you modify it and provide it as a network service, you must make the corresponding modified source available to users of that service.

## Acknowledgments

CloudCLI builds on [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Cursor CLI](https://docs.cursor.com/en/cli/overview), [Codex](https://developers.openai.com/codex), [OpenCode](https://opencode.ai), React, Vite, Tailwind CSS, CodeMirror, xterm.js, Express, and Electron.

Sponsored by [Siteboon](https://siteboon.ai).

<div align="center"><strong>Made with care for the coding-agent community.</strong></div>
