# Architecture

**Analysis Date:** 2026-04-20

## Pattern Overview

**Overall:** pnpm monorepo, three-process distributed system bridged by a stateless WebSocket relay.

**Key Characteristics:**
- Three deployable apps + one shared package: `apps/proxy`, `apps/relay`, `apps/web`, `packages/shared`.
- Proxy side is a multi-process system (one long-lived daemon `serve`, many short-lived `terminal`/`session-worker` children) talking over a Unix domain socket at `~/.cc-anywhere/run/cc-anywhere.sock`.
- Relay is intentionally stateless — no message buffer, no replay store. See explicit comment `apps/relay/src/router.ts:75` ("relay 无状态") and `apps/relay/src/registry.ts:187` (`getSessionSeqMap` returns `{}`).
- Dual-mode Claude Code wrapping: PTY mode (`apps/proxy/src/terminal.ts`) for transparent terminal, JSON mode (`apps/proxy/src/session-worker.ts` + `apps/proxy/src/json-session.ts`) for programmatic remote control via `claude --output-format stream-json`.
- Transport is mixed: JSON text envelopes + raw WebSocket binary frames for PTY byte streams (zero-copy pass-through in relay). See `apps/relay/src/handlers/proxy.ts:78-103`.
- Protocol split personality: `MessageEnvelope` (seq/sessionId/timestamp/source/version) vs `RelayControlMessage` (flat, no seq). Router `parseMessage` in `apps/relay/src/router.ts:18` tries control schema first, then envelope.

## Layers

**Shared Schema Layer (`packages/shared`):**
- Purpose: Single source of truth for wire protocol between proxy / relay / web.
- Location: `packages/shared/src/`
- Contains: Zod schemas (`schemas/envelope.ts`, `schemas/relay-control.ts`, `schemas/session.ts`, `schemas/chat.ts`, `schemas/tool.ts`, `schemas/system.ts`), `buildMessage` helper (`builders/index.ts`), `SessionState` enum (`constants/session.ts`), pino logger factory (`logger.ts`).
- Depends on: `zod`, `pino`, `nanoid`.
- Used by: all three apps. Published as `@cc-anywhere/shared` (workspace-only). Must be rebuilt (`pnpm --filter shared run build`) after schema edits because consumers import from `dist/`.

**Proxy — Terminal Process (`apps/proxy/src/terminal.ts`):**
- Purpose: The user-visible Claude Code wrapper; owns PTY and stdio.
- Spawns `claude` via `node-pty` through `PtyManager` (`apps/proxy/src/pty-manager.ts`).
- Duplicates PTY output: writes to `process.stdout` (user terminal) AND to `@xterm/headless` Terminal instance (for remote snapshots) AND as binary IPC frames over socket to `serve`.
- Extracts OSC 0 (title) / OSC 9 (approval, turn_complete) signals via `osc-extractor.ts` to synthesize `pty_state_push`.
- Serializes current terminal grid on demand via `SerializeAddon` when `pty_subscribe` arrives (web client just opened).
- Lifecycle states: `INIT → CONNECTING_SERVICE → CREATING_SESSION → RUNNING → (RECONNECTING) → EXITED` (`terminal.ts:26-33`).
- Auto-spawns `serve` daemon if not running (`ensureService`, `terminal.ts:48-83`).

**Proxy — Serve Daemon (`apps/proxy/src/serve.ts`):**
- Purpose: Singleton background IPC server. Holds `SessionManager`, manages worker processes, maintains single outbound WS to relay.
- Listens on Unix socket `SOCK_PATH` for connections from any of: terminal (PTY sessions), CLI (`status`/`list`), session-workers (JSON sessions).
- Fanout role: routes IPC messages between terminal ↔ worker ↔ relay with no per-message schema translation; it rewrites envelope types in both directions (terminal binary → WS binary with sessionId-prefix frame; worker JSON events → typed envelopes via `forwardWorkerEvent` at `serve.ts:169-220`).
- Owns relay-inbound demuxer: the giant `relayConnection.on("message", ...)` switch at `serve.ts:811-1129` handles user_input, tool approvals, dir_list, session_create, etc. This file is the tangle hotspot — ~1184 lines, most of which is cross-layer translation logic mixed with in-proc state.
- State management: `pendingToolApprovals` map, `claudeSessionIds` map, `workerSockets` + `terminalSockets` maps all live as module-level `const` inside `startService()`.
- Delegates resource discovery (command list, dir listing, history) to `handlers/control-messages.ts`.

**Proxy — Session-Worker (`apps/proxy/src/session-worker.ts`):**
- Purpose: Short-lived child that owns one `claude --output-format stream-json --permission-prompt-tool stdio` process.
- Each worker listens on its own Unix socket `~/.cc-anywhere/data/<sessionId>/worker.sock`; serve connects as client.
- Translates stream-json events to `worker_event` IPC frames (see `ipc-protocol.ts:180-250` for `WorkerMessageSchema`).
- Handles tool approval round-trip: `worker_approval_request` → serve → relay → client → relay → serve → `worker_approval_response`.
- Per-session `ToolWhitelist` for "approve + whitelist tool" UX (auto-approve subsequent calls to same tool name).

**Relay — HTTP + WS server (`apps/relay/src/`):**
- Purpose: Pure message router. No storage, no queue, no per-message transformation.
- Entry: `index.ts` → `server.ts::createRelayServer`. Two `WebSocketServer` instances on same HTTP port: `/proxy` (token-authed) and `/client` (open).
- Registry (`registry.ts`) is the whole state model: `proxyId → ProxyState` (ws, connectionState, sessions Set, name), `clientId → ClientBinding` (proxyId, ws, state). Connection states are explicit (`online`/`offline`, `registered`/`bound`) with validated transitions (`transitionProxy`, `transitionClient`).
- Routing (`router.ts`): JSON text goes through schema-based parse, then `routeProxyMessage` / `routeClientMessage`. Binary frames bypass parsing entirely — first byte is sessionId length, rest is opaque PTY bytes, forwarded as-is to all bound clients (`handlers/proxy.ts:78-103`).
- Two explicit whitelists define what flows across: `PROXY_TO_CLIENT_TYPES` (`handlers/proxy.ts:10-26`) and `CLIENT_TO_PROXY_TYPES` (`handlers/client.ts:8-20`). Any new control type must be added here or it will silently drop.
- Health: `healthRouter` (`health.ts`), heartbeat (`heartbeat.ts`) uses WebSocket ping with `isAlive` tracking.
- Static file serving for `/fonts` (CJK font shards served from `DATA_DIR/fonts`).

**Web — SPA (`apps/web/src/`):**
- Purpose: React 19 SPA, also shipped as PWA via `vite-plugin-pwa`.
- Entry: `main.tsx` → `<App>` in `app.tsx` → `useRelaySetup()` + `<RouterProvider>`.
- Router: hash router (`lib/router.tsx`) — `/` proxy select, `/sessions`, `/chat/:id?mode=pty|json`, plus debug pages `/pty-test`, `/tokens`, `/markdown-test`.
- Single WebSocket connection to relay `/client` endpoint, managed by `services/websocket.ts::WebSocketManager` (exponential backoff reconnect, binary subscription by sessionId prefix).
- Protocol layer: `services/relay-client.ts::RelayClient` wraps `WebSocketManager`, handles `client_register` / `proxy_list` / `proxy_select`, parses inbound JSON to typed envelope/control union.
- Phase machine: `services/phase-machine.ts` drives `AppPhase` transitions (`connecting → registering → proxy_selecting → session_browsing → chatting`, with `reconnecting` side state).
- Dispatchers (registered once in `useRelaySetup`): `chat-dispatcher.ts`, `session-dispatcher.ts`, `resource-dispatcher.ts` — each subscribes to `RelayClient.onMessage` and writes to its own Zustand store.
- State: zustand stores in `stores/` (`app-store`, `session-store`, `chat-store`, `command-store`, `file-store`).
- Terminal rendering: `lib/create-xterm.ts` constructs `@xterm/xterm` with WebGL addon and Sarasa Fixed SC font; consumed by `components/chat/chat-pty-view.tsx`.

## Data Flow

**PTY terminal output → web render (hot path):**

1. `claude` CLI writes to PTY master fd.
2. `PtyManager.handleData` (`apps/proxy/src/pty-manager.ts:106`) fixes OSC `\r\n` → `\n`, writes raw data to `process.stdout` AND invokes `tap(data)`.
3. `tap` closure in `terminal.ts:245-270` does three things synchronously:
   - `headlessTerminal.write(data)` (local xterm headless mirror for future snapshots).
   - `socket.write(encodeBinaryIpcFrame(sessionId, Buffer.from(data)))` — binary frame over IPC to serve.
   - OSC signal extraction → `sendPtyState()` if state transitions.
4. `createIpcReader` in `serve.ts:690-701` receives binary frame, wraps it in WebSocket binary frame `[1B sessionId_len][sessionId][data]` and calls `relayConnection.sendBinary`.
5. Relay `handleProxyConnection` (`handlers/proxy.ts:80`) sees `isBinary`, validates prefix, forwards entire buffer unchanged to every client bound to the proxy (`handlers/proxy.ts:96-101`, marked `D-42: zero-copy`).
6. `WebSocketManager.dispatchBinary` (`apps/web/src/services/websocket.ts:126`) strips the sessionId prefix and fans out to the `subscribeBinary(sessionId, ...)` handler registered by `ChatPtyView`.
7. `terminal.write(data)` on the xterm.js instance renders via WebGL.

**Web input → terminal stdin (PTY mode):**

1. User types in `InputBar` or sends a raw ANSI byte (cursor keys, Shift+Tab).
2. For text: `relayClient.sendEnvelope(buildMessage("user_input", sessionId, ...))`. For raw bytes: `sendControl({ type: "remote_input_raw", sessionId, data })`.
3. Relay `client.ts:188-198` / `routeClientMessage` forwards to bound proxy WebSocket.
4. `serve.ts:811` relay-inbound switch: `user_input` branch adds `\r` terminator and sends `pty_input` IPC frame to the terminal socket; `remote_input_raw` branch passes bytes through verbatim (`serve.ts:846-865`).
5. `terminal.ts:133-135` receives `pty_input` via `createIpcReader` and calls `ptyManager.write(data)`, which writes to the PTY master fd → `claude` reads it on its stdin.

**Web input → Claude (JSON mode):**

1. Client sends `user_input` envelope.
2. `serve.ts:820-832`: looks up `workerSockets.get(sessionId)`, sends `worker_input` via `serializeWorkerMsg` to the session-worker socket. Also transitions session state to `WORKING` synchronously (`session-worker.ts` does not drive state by observing events; see comment at `serve.ts:822-824`).
3. `session-worker.ts` → `JsonSession.writeInput(content)` pushes a stream-json user message into claude's stdin.
4. claude emits stream-json `assistant` / `result` / `system` events → worker wraps as `worker_event` with monotonic `seq`.
5. `forwardWorkerEvent` (`serve.ts:169-220`) routes: `assistant.content[].type==="text"` → `assistant_message` envelope; `thinking` block → `thinking` envelope; `result` → `turn_result` control message + `IDLE` transition.
6. Relay transparently forwards envelope to client; `chat-dispatcher.ts` reads the typed union and updates `chat-store`.

**Session lifecycle:**

Creation (PTY): `claude` invocation → `terminal.ts::startTerminal` sends `session_create_request` → serve creates `SessionInfo` in `SessionManager` → returns `session_create_response` → terminal sends `pty_register` → serve announces via `session_sync` and `session_list` to relay → web `session-dispatcher` updates `session-store`.

Creation (JSON, remote): web `session_create` control → serve spawns worker (`spawnWorker`, `serve.ts:350`) → retries connecting to worker's Unix socket up to 20 times → creates `SessionInfo` → sends `session_create_response` control → pushes command list and file tree via `controlHandlers.pushCommandList` / `pushFileTree`.

State machine: `SessionState` enum (`packages/shared/src/constants/session.ts`) has IDLE / WORKING / WAITING_APPROVAL / ERROR / TERMINATED. Valid transitions enforced by `SessionManager.updateState` (`session-manager.ts:92-110`) and `VALID_TRANSITIONS` table. TERMINATED is terminal (no transitions out). `changeSessionState()` helper in `serve.ts:81-97` wraps updateState with envelope push and silent no-op on same-state / invalid transition.

Termination: explicit via `session_terminate` control (client) or `session_terminate_request` IPC (CLI). Crash paths: terminal socket close + process dead → `serve.ts:703-745` runs full cleanup. Worker socket close → `workerSockets.delete`, pending approvals resolved as `deny`.

**Replay / snapshot flow (PTY):**

Relay is stateless: `replay_request` always returns `gap_unrecoverable` (`router.ts:76-102`). PTY snapshot flow is the production recovery path:

1. Web client opens `/chat/:id?mode=pty` → `ChatPtyView` subscribes to binary frames.
2. Client sends `session_subscribe` control → relay forwards → `serve.ts:1111-1119` converts to `pty_subscribe` IPC → terminal.
3. `terminal.ts:136-148` calls `serializeAddon.serialize()` on the headless xterm mirror → sends `pty_snapshot` IPC with cols/rows and serialized data.
4. Serve wraps as `session_snapshot` control → relay forwards to bound clients.
5. Client applies snapshot to its xterm.js instance, then flushes buffered binary frames (`frameBuffer` in `chat-pty-view.tsx:87`).

JSON mode resume: `session_messages_request` control → serve calls `readSessionMessages(claudeSessionId)` (`session-history.ts`) which reads `~/.claude/projects/<encoded>/<sessionId>.jsonl` → returns `session_history_messages` control.

**State Management:**

Proxy side: in-memory maps in serve (`workerSockets`, `terminalSockets`, `pendingToolApprovals`, `claudeSessionIds`). Persistent: `SessionManager` dumps `SessionInfo[]` to `~/.cc-anywhere/state/sessions.json`. Per-session data dir at `~/.cc-anywhere/data/<sessionId>/` contains `worker.sock` (live) and historically `events.bin` (no longer used — relay is stateless).

Relay side: everything in `RelayRegistry` Maps, zero persistence.

Web side: zustand stores per concern, `clientId` persisted to `sessionStorage` (`app-store.ts:50-56`), `relayUrl` derived from `window.location.origin`.

## Key Abstractions

**RelayConnection (`apps/proxy/src/relay-connection.ts`):**
- Purpose: Manages the single outbound WebSocket from serve to relay.
- Responsibilities: proxyId persistence to `~/.cc-anywhere/proxy-id`, exponential backoff reconnect (base 1s, max 30s), offline message queue (`MemoryMessageQueue`, cap 10000), connection state machine (`DISCONNECTED/CONNECTING/REGISTERING/SYNCED/WAITING_RECONNECT/CLOSED`), emits `message` / `connected` events for serve to subscribe.
- Used by: `serve.ts:800-806`.

**SessionManager (`apps/proxy/src/session-manager.ts`):**
- Purpose: Authoritative list of sessions in the serve process, with state-transition enforcement and JSON persistence.
- Responsibilities: create/list/get/terminate sessions; validate state transitions against `VALID_TRANSITIONS` table; reaper timer for stale sessions (default 60s); `onSessionRemoved` hook for cleanup (used by serve to `rmSync` the session data dir).
- `SessionInfo` fields: id, mode, state, createdAt/updatedAt, name, cwd, claudeSessionId, pid.

**PtyManager (`apps/proxy/src/pty-manager.ts`):**
- Purpose: Owns one `node-pty` child running `claude`.
- Responsibilities: resolve `claude` binary via `$CLAUDE_BIN` or `which claude`, spawn with inherited env + cwd; pipe stdin ↔ PTY ↔ stdout ↔ tap; 50ms debounce on window resize; OSC 9 `\r\n` → `\n` fixup; translate signal exit to Unix `128+signal` code.

**createIpcReader (`apps/proxy/src/ipc-protocol.ts:288`):**
- Purpose: Mixed-protocol stream parser over Unix domain socket.
- Handles two intermixed frame types on the same socket: NDJSON lines (`{` start, `\n` terminator) and binary frames (marker byte `0x00`, then `[4B len LE][1B sid_len][sid][payload]`).
- Used by terminal ↔ serve and CLI ↔ serve. Workers use `createWorkerReader` (NDJSON only).

**RelayRegistry (`apps/relay/src/registry.ts`):**
- Purpose: Sole state container for the relay.
- Owns: proxy states (ws, sessions Set, connection state, name), client bindings (proxyId, ws, state), global client set (for `broadcastProxyList`).
- Explicit state transitions with `transitionProxy` / `transitionClient` — reject same-state transitions with thrown error instead of silent no-op.

**RelayClient + WebSocketManager (`apps/web/src/services/`):**
- `WebSocketManager`: thin wrapper over browser `WebSocket`. Dispatches text messages to `messageHandlers` set, binary to `binarySubscribers` keyed by sessionId (parsed from 1-byte-len-prefix). Exponential backoff, pending queue while disconnected.
- `RelayClient`: protocol-aware layer on top. Owns `clientId`, `boundProxyId`, `sessionSeqMap`. Single `onMessage` registration forwards to any number of `messageHandlers`, with pre-subscribe buffering (`pendingMessages`).

**phase-machine (`apps/web/src/services/phase-machine.ts`):**
- Purpose: Central switch for relay-inbound control messages that affect app-level state (connection, proxy binding, navigation).
- `handleWsStatusChange` drives connect/reconnect transitions; `handleRelayMessage` handles `client_register_response` / `proxy_offline` / `proxy_online` / `proxy_list_response` / etc.
- Other control messages are consumed by domain dispatchers (chat/session/resource), not the phase machine.

**Dispatchers (`apps/web/src/services/*-dispatcher.ts`):**
- Each owns a subset of message types and writes into one zustand store.
- `chat-dispatcher`: `assistant_message`, `tool_use_request`, `tool_result`, `pending_approvals_push`, `session_history_messages`, `turn_result`, `terminal_title`.
- `session-dispatcher`: `session_list`, `session_status`, `pty_state`, `session_history_response`.
- `resource-dispatcher`: `command_list_push`, `dir_list_response`, `file_tree_push`.
- Registered once in `useRelaySetup`; unregistered on app unmount.

## Entry Points

**cc-anywhere CLI (`apps/proxy/src/index.ts`):**
- Location: bin `dist/index.js`, declared in `apps/proxy/package.json:bin`.
- `cc-anywhere` with no subcommand → `startTerminal(cliArgs)`. `cc-anywhere init`, `serve start|stop|status|restart`, `serve` (foreground daemon).

**serve daemon (`apps/proxy/src/serve.ts::startService`):**
- Spawned detached by `startTerminal` auto-start or explicit `cc-anywhere serve -d`.
- Listens on `SOCK_PATH`, writes `PID_PATH`, reads config from `~/.cc-anywhere/config.json`.

**session-worker (`apps/proxy/src/session-worker.ts`):**
- Spawned by serve `spawnWorker`. argv: `<sessionId> <sockPath> [--cwd] [--resume] [--permission-mode] -- [claudeArgs...]`.
- Detached, stdio:ignore. Writes to own Unix socket, serve connects in.

**relay server (`apps/relay/src/index.ts`):**
- Reads `PORT` (default 3100), `DATA_DIR`, `HEARTBEAT_INTERVAL`, `RELAY_PROXY_TOKEN`.
- Production: run via Docker Compose in `apps/relay/docker-compose.yml`, fronted by nginx (`apps/relay/nginx.conf`).

**web SPA (`apps/web/index.html` → `src/main.tsx` → `src/app.tsx`):**
- Dev: `vite` on port 5173, proxies `/proxy`, `/client`, `/fonts`, `/health` to localhost:3100.
- Prod: static build served by nginx container, same-origin WebSocket to `/client`.

## Error Handling

**Strategy:** Most error paths return JSON error frames rather than throwing. WS-layer errors silently swallowed with log at warn/error.

**Patterns:**
- Relay emits `{ type: "relay_error", code, message }` on any validation failure. Codes: `NOT_REGISTERED`, `NOT_BOUND`, `PROXY_OFFLINE`, `INVALID_MESSAGE`, `UNSUPPORTED`, `INVALID_RANGE` (not a typed enum — string literals throughout `handlers/proxy.ts` and `handlers/client.ts`). The `ErrorCode` enum in `packages/shared/src/constants/errors.ts` exists but is not used by the relay error frames, only by envelope `error` payloads. Inconsistency: two parallel error-code vocabularies.
- Session state transitions: invalid transitions throw in `SessionManager.updateState` but `changeSessionState` (`serve.ts:81-97`) swallows them with debug log — silent rejection, not surfaced to caller.
- Tool approval pending callbacks: on worker disconnect, all pending approvals for that session are auto-resolved as `deny` (`serve.ts:323-342`). On relay disconnect mid-approval, nothing automatic — the approval sits in `pendingToolApprovals` indefinitely.
- Schema validation failures in `createIpcReader` → `console.warn` + drop the frame (`ipc-protocol.ts:332-337`). Not propagated to caller.
- Worker stream-json parse errors: dropped silently in `createWorkerReader` (`ipc-protocol.ts:272-274`) — comment says "not to break the stream".

**Tangles / cross-layer concerns:**
- `serve.ts` relay-inbound handler (L811-1129) is one giant `if/else` chain dispatching on `parsed.type`. It mixes: envelope routing (user_input / tool_approve / tool_deny), control message routing (dir_list, session_create, etc.), and session state side-effects. No schema validation on the inbound side — it works on `parsed.type` string comparisons against untyped `parsed.payload?.text ?? ""` reads. This is the opposite of what `packages/shared/src/schemas` provides on the outbound side.
- `PROXY_TO_CLIENT_TYPES` (`apps/relay/src/handlers/proxy.ts:10`) and `CLIENT_TO_PROXY_TYPES` (`apps/relay/src/handlers/client.ts:8`) are hardcoded allowlists. Adding a new control message type requires editing both ends AND at least one of these lists; forgetting the list causes silent drop (see memory: "relay control allowlist").
- `terminal_frame_request` (`serve.ts:1120`) and `terminal_scroll_request` (`serve.ts:1122`) are explicitly ignored no-ops retained for client backward compatibility — zombie code paths.

## Cross-Cutting Concerns

**Logging:**
- Pino with optional pretty transport (`packages/shared/src/logger.ts::createLogger`).
- Proxy: `apps/proxy/src/logger.ts` exports named loggers per component (`terminalLogger`, module `logger`), writes to `~/.cc-anywhere/logs/service.log`.
- Relay: stdout only (`apps/relay/src/index.ts:14`), Docker captures.
- Web: `console.warn` / `console.error` — no structured logger.
- Convention (per `CLAUDE.md`): all log messages in English, code comments/docstrings in Chinese.

**Validation:**
- Outbound (proxy → relay → client): zod-validated via `buildMessage` for envelopes, direct `JSON.stringify` for control messages (no validation).
- Inbound on relay: `parseMessage` (`router.ts:18`) tries `RelayControlSchema` then `MessageEnvelopeSchema`.
- Inbound on proxy serve (from relay): NO validation. Direct `parsed.type === "..."` checks on untyped JSON.
- Inbound on web (from relay): parsed as untyped union, dispatchers cast to expected shape (e.g. `chat-dispatcher.ts` uses `Extract<MessageEnvelope, { type: "..." }>`).

**Authentication:**
- `/proxy` WS endpoint: shared-secret `RELAY_PROXY_TOKEN` via `?token=` query param. Proxy loads from `~/.cc-anywhere/config.json` (`apps/proxy/src/config.ts`).
- `/client` WS endpoint: unauthenticated. Any browser that can reach the relay can bind to any proxy by proxyId. There is no per-user access control.
- Web `clientId`: random nonce in `sessionStorage`, per-tab. Used only for binding recovery across reconnects, not for auth.

**Transport framing:**
- WebSocket text frames: one JSON message per frame.
- WebSocket binary frames: `[1B sid_len][sid UTF-8][opaque PTY bytes]` on both proxy→relay and relay→client hops. Zero-copy through relay.
- IPC (Unix socket): mixed binary + NDJSON. Binary frame header `[0x00][4B LE len][1B sid_len][sid][payload]`. Disambiguated by first byte (`{` = JSON, `0x00` = binary).

---

*Architecture analysis: 2026-04-20*
