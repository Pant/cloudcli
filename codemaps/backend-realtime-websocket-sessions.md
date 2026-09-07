# Backend Realtime, WebSocket, and Session Runs

## Scope and boundaries

This map covers the server-side WebSocket gateway, especially the `/ws` chat/session protocol: authentication, route selection, run ownership, event normalization, subscription/replay, and cross-module session broadcasts. The same gateway also routes `/shell`, `/desktop-notifications`, and `/plugin-ws/:pluginName`; those are summarized only to locate transport ownership.

Frontend socket lifecycle, dispatch, and browser state reconciliation belong in [`frontend-chat-session-state.md`](frontend-chat-session-state.md) and [`shared-contracts-api-transport.md`](shared-contracts-api-transport.md). Provider implementation and CLI process details belong in [`backend-agent-provider-cli.md`](backend-agent-provider-cli.md). The external `POST /api/agent` path in `server/modules/agent/agent.routes.ts` uses `SSEStreamWriter` or `ResponseCollector`, not this WebSocket run registry.

## Entry points and route ownership

| Symbol | Defined in | Role |
|---|---|---|
| `createWebSocketServer` | `server/modules/websocket/services/websocket-server.service.ts` | Creates one `WebSocketServer` in `noServer` mode, handles HTTP upgrades, and routes accepted connections by pathname. |
| `attachWebSocketHeartbeat` | `server/modules/websocket/services/websocket-server.service.ts` | Pings each accepted socket every 30 seconds by default and terminates half-open connections that fail to pong. |
| `verifyWebSocketClient` | `server/modules/websocket/services/websocket-auth.service.ts` | Authenticates before `connection`: platform mode resolves a user without a token; OSS mode reads `?token` before the Bearer header and attaches `request.user`. |
| `handleChatConnection` | `server/modules/websocket/services/chat-websocket.service.ts` | Owns `/ws`, registers chat clients, parses inbound commands, and detaches closed sockets. |
| `handleShellConnection` | `server/modules/websocket/services/shell-websocket.service.ts` | Owns `/shell` PTY initialization, input/resize, output buffering, and reconnect behavior. |
| `handleDesktopNotificationsConnection` | `server/modules/notifications/index.ts` | Owns `/desktop-notifications`; it is routed by the shared gateway but implemented by notifications. |
| `handlePluginWsProxy` | `server/modules/websocket/services/plugin-websocket-proxy.service.ts` | Owns `/plugin-ws/:pluginName` and relays frames to a running plugin's local WebSocket. |
| `connectedClients`, `WS_OPEN_STATE` | `server/modules/websocket/services/websocket-state.service.ts` | Shared set of open `/ws` chat sockets and the transport-neutral open ready-state constant. |
| WebSocket barrel exports | `server/modules/websocket/index.ts` | Exposes `createWebSocketServer`, shared state, run services, and startup recovery to server/module consumers. |

`createWebSocketServer` deliberately excludes `/api/docs-ui/api` from its upgrade handling. Accepted sockets receive heartbeat handling before pathname dispatch; unknown paths are logged and closed.

## Chat/session runtime symbols

| Symbol | Defined in | Role |
|---|---|---|
| `chatRunLifecycleService` | `server/modules/websocket/services/chat-run-lifecycle.service.ts` | Durable orchestration owner. `start`, `restart`, `manualStart`, and `stop` coordinate session DB state, generation claims, provider runtime execution, terminal history, and registry completion. |
| `chatRunRegistry` | `server/modules/websocket/services/chat-run-registry.service.ts` | In-memory source of truth for active/recent runs keyed by stable app session ID; assigns sequence numbers, buffers events, owns subscribers, and guarantees at most one forwarded `complete`. |
| `ChatSessionWriter` | `server/modules/websocket/services/chat-session-writer.service.ts` | Provider-facing writer adapter that captures provider-native IDs, suppresses `session_created`, and sends normalized events through registry decoration/fanout. |
| `handleChatSend` | `server/modules/websocket/services/chat-websocket.service.ts` | Validates the app session, derives provider/project data from `sessionsDb`, revalidates attachments, and delegates to `chatRunLifecycleService.start`. |
| `handleChatAbort` | `server/modules/websocket/services/chat-websocket.service.ts` | Requires a running registry entry and delegates cancellation to `chatRunLifecycleService.stop`. |
| `handleChatSubscribe` | `server/modules/websocket/services/chat-websocket.service.ts` | Creates a generation-aware replay boundary, sends `chat_subscribed`, replays retained events, then flushes live events queued during replay. |
| `handlePermissionResponse` | `server/modules/websocket/services/chat-websocket.service.ts` | Forwards a provider-neutral approval decision to `providerRuntimeService.resolveToolApproval` through the injected runtime gateway. |
| `reconcileInterruptedOpenCodeRuns` | `server/modules/websocket/services/opencode-run-recovery.service.ts` | Startup-only inspection that marks stale OpenCode runs interrupted when registry/runtime/child-process/approval evidence shows nothing live. |
| `WebSocketWriter` | `server/modules/websocket/services/websocket-writer.service.ts` | Generic raw-socket writer adapter for non-chat writer consumers; chat provider runs use `ChatSessionWriter` instead. |

Important registry methods are `startRun`, `getRun`, `isProcessing`, `listRunningRuns`, `beginSubscription`, `finishSubscription`, `detachConnection`, `completeRun`, and `completeRunIfCurrent`. Completed runs remain in memory for five minutes; each run retains at most 5,000 events, after which REST history is required for older gaps.

## Connection and event flow

```mermaid
sequenceDiagram
  participant Browser
  participant HTTP as HTTP server / WebSocketServer
  participant Auth as verifyWebSocketClient
  participant Chat as handleChatConnection
  participant Life as chatRunLifecycleService
  participant Registry as chatRunRegistry
  participant Writer as ChatSessionWriter
  participant Runtime as providerRuntimeService
  participant DB as sessionsDb / sessionRunStateDb

  Browser->>HTTP: WebSocket upgrade /ws (?token or Authorization)
  HTTP->>Auth: verifyClient(info)
  Auth-->>HTTP: attach request.user and accept, or reject
  HTTP->>Chat: connection + heartbeat
  Chat->>Chat: add socket to connectedClients
  Browser->>Chat: chat.send {sessionId, content, options}
  Chat->>DB: load canonical session/provider/project path
  Chat->>Life: start(app session ID, command, safe options, socket, user)
  Life->>DB: begin durable run generation
  Life->>Registry: startRun(... generation ...)
  Registry-->>Life: ChatSessionWriter-backed run
  Life->>Runtime: run(provider, command, options, writer)
  Runtime->>Writer: normalized kind-based events
  alt session_created or setSessionId
    Writer->>Registry: capture provider-native ID
    Registry->>DB: persist app-ID/provider-ID mapping
    Registry-->>Browser: session_upserted broadcast
  else normal event
    Writer->>Registry: remap sessionId; add generation + seq; buffer
    Registry-->>Browser: fan out to run subscribers
  end
  Runtime-->>Life: resolve/reject
  Life->>DB: record terminal lifecycle/history
  Life->>Registry: completeRunIfCurrent if runtime did not complete
  Registry-->>Browser: exactly one kind: complete
```

### Reconnect and replay

1. A client sends `chat.subscribe` with one or more `{ sessionId, generation?, lastSeq? }` cursors.
2. `chatRunRegistry.beginSubscription` captures the current sequence boundary. For a running run it marks this requester as replaying, so later live events queue only for that socket.
3. The server sends `chat_subscribed`, including `generation`, `lastSeq`, replay range, gap/refresh flags, processing state, history revision, and pending permissions.
4. Retained events after the cursor are sent only when coverage is complete. Missing/truncated coverage or stale completed coverage sets `refreshRequired`; canonical persisted history must then be fetched over REST.
5. `finishSubscription` ends the replay phase and flushes post-boundary queued events in order. Socket close invokes `detachConnection` across all runs.

## Protocol and event categories

### Client-to-server `/ws` commands

| Command | Key payload | Backend action |
|---|---|---|
| `chat.send` | `sessionId`, `content`, optional `options` | Starts one provider run for an existing app session. Session provider/path are server-owned; attachment paths are revalidated. |
| `chat.abort` | `sessionId` | Aborts the active provider run and produces a synthetic terminal event if needed. |
| `chat.subscribe` | `protocolVersion`, `sessions[]` cursors | Additively attaches/re-attaches streams and requests generation-aware replay. `ChatSubscribeCommand` and `ChatSubscriptionCursor` define the shared typed shape. |
| `chat.permission-response` | `requestId`, `allow`, optional updated input/message/remember entry | Resolves a pending interactive tool approval. |

Malformed JSON, unsupported commands, absent sessions, unsupported providers, and invalid run state return gateway frames with `kind: 'protocol_error'` and a machine-readable `code`.

### Server-to-client categories

- **Provider-neutral run messages:** `NormalizedMessage` in `shared/cloudcli-contracts.ts`, discriminated by `MessageKind`: `text`, `tool_use`, `tool_result`, `thinking`, `stream_delta`, `stream_end`, `error`, `complete`, `status`, `permission_request`, `permission_cancelled`, `session_created`, `interactive_prompt`, and `task_notification`. On the chat transport, `session_created` is consumed internally rather than forwarded.
- **Sequenced live events:** `SequencedChatEvent` declares required `protocolVersion`, `generation`, and `seq` on a normalized message. The current registry decoration observably adds `generation` and `seq` (but not `protocolVersion`) and remaps provider-native identifiers to the app session ID; treat that contract/implementation difference as a coordination point when tightening parsing.
- **Subscription acknowledgement:** `ChatSubscribedEvent` with `kind: 'chat_subscribed'`, replay coverage, processing state, and pending approvals.
- **Session/project fanout:** `kind: 'session_upserted'` is broadcast through `connectedClients` by the run registry after provider-ID mapping and by provider session watchers; `kind: 'loading_progress'` is broadcast while project/session snapshots load.
- **Gateway errors:** `kind: 'protocol_error'`, separate from provider `kind: 'error'`.
- **Terminal contract:** exactly one `kind: 'complete'` per run. `ChatSessionWriter.sendComplete` synthesizes one for abort/failure/no-terminal-event cases, while registry guards drop duplicates.

`CLOUDCLI_PROTOCOL_VERSION`, `CloudCliProtocolVersion`, `NormalizedMessage`, `MessageKind`, `ChatSubscriptionCursor`, `ChatSubscribeCommand`, `ChatSubscribedEvent`, and `SequencedChatEvent` are defined in `shared/cloudcli-contracts.ts`. Coordinate changes to these shapes with the cross-layer contract map rather than defining frontend behavior here.

## Coupling points and invariants

- **Server bootstrap:** `server/index.ts` injects authentication, runtime, shell, and plugin-port dependencies into `createWebSocketServer`; transport services avoid importing legacy runtime composition directly.
- **Database/session identity:** `/ws` accepts only stable app session IDs. `sessionsDb` supplies canonical provider and project path. `ChatSessionWriter` captures provider-native IDs and `sessionsDb.assignProviderSessionId` persists the mapping; native IDs do not cross the chat boundary.
- **Provider execution:** `chatRunLifecycleService` calls the centralized `providerRuntimeService`, while the registry provides the writer and run-level subscription state. Provider-specific behavior should not be added to command dispatch.
- **Durable lifecycle:** `sessionRunStateDb` owns generations, progress, terminal state, and run history; the registry owns transient event delivery and replay.
- **Global broadcasts:** only `/ws` sockets enter `connectedClients`. Project loading, session watchers, and canonical mapping updates use this set for non-run-specific fanout.
- **Adjacent agent API:** `createAgentModule`/`createAgentRouter` in `server/modules/agent` dispatch the same provider families for external API requests, but `SSEStreamWriter` and `ResponseCollector` form a separate transport/session-ID path. Do not assume its `type`-based SSE events are `/ws` protocol frames.

## Change and extension points

- Add a WebSocket pathname in `createWebSocketServer`, add a focused handler service, extend `WebSocketServerDependencies`, and wire its dependency at bootstrap.
- Add a chat command in `handleChatConnection`; define/validate its shared contract and preserve the distinction between inbound `type` and outbound `kind`.
- Change replay policy in `chatRunRegistry.beginSubscription`/`finishSubscription`; preserve boundary-safe ordering, generation semantics, bounded retention, and REST fallback.
- Change provider event adaptation in `ChatSessionWriter` and registry decoration, not in frontend-specific branches. Preserve app-session remapping and exactly-one-complete behavior.
- Add global realtime announcements through a typed contract and guarded iteration of `connectedClients`; do not add shell/plugin sockets to this chat registry accidentally.

## Focused validation and tests

| Test/source | What it verifies or should be checked for |
|---|---|
| `server/modules/websocket/tests/chat-run-registry.test.ts` | Sequencing, replay boundaries/gaps, subscriptions, completion, provider-ID mapping, and fanout behavior. |
| `server/modules/websocket/tests/chat-run-lifecycle.test.ts` | Durable start/stop/finalization and provider runtime orchestration. |
| `server/modules/websocket/tests/opencode-run-recovery.test.ts` | Startup interrupted-run reconciliation. |
| `server/modules/websocket/tests/websocket-heartbeat.service.test.ts` | Ping/pong liveness and half-open termination. |
| `server/modules/websocket/tests/chat-attachment-filter.test.ts` | Server-side attachment filtering used by `chat.send`. |
| `server/modules/websocket/tests/shell-websocket.service.test.ts` | Adjacent `/shell` initialization, validation, PTY, and reconnect behavior. |
| `shared/cloudcli-contracts.test.ts` | Shared protocol parsers and event envelope contracts. |

Documentation validation for this map: compare all named symbols with the cited definitions; compare every listed `chat.*` command, `MessageKind`, and gateway `kind` with `chat-websocket.service.ts`, `chat-run-registry.service.ts`, and `shared/cloudcli-contracts.ts`; then walk the diagram against `handleChatSend` → `chatRunLifecycleService.start` → `chatRunRegistry.startRun` → `ChatSessionWriter.send`.
