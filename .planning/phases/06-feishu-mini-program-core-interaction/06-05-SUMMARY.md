---
phase: "06"
plan: "05"
subsystem: relay, proxy
tags: [relay-routing, terminal-frame, control-messages, proxy-name, incremental-diff, whitelistTool]
dependency_graph:
  requires: [06-01, 06-03]
  provides: [relay-terminal-frame-routing, proxy-terminal-push, control-message-handlers, proxy-name-registration, whitelistTool-protocol]
  affects: [apps/relay, apps/proxy, packages/shared]
tech_stack:
  added: []
  patterns: [composition-root-pattern, incremental-line-diff, handler-module-extraction]
key_files:
  created:
    - apps/proxy/src/handlers/terminal-push.ts
    - apps/proxy/src/handlers/control-messages.ts
    - apps/proxy/src/session-history.ts
    - apps/proxy/src/__tests__/session-history.test.ts
    - apps/proxy/src/__tests__/terminal-push.test.ts
  modified:
    - apps/relay/src/router.ts
    - apps/relay/src/handlers/client.ts
    - apps/relay/src/handlers/proxy.ts
    - apps/relay/src/registry.ts
    - packages/shared/src/schemas/tool.ts
    - apps/proxy/src/serve.ts
    - apps/proxy/src/relay-connection.ts
decisions:
  - "terminal_frame added to relay compression trigger types alongside pty_snapshot"
  - "Proxy-to-client relay control messages forwarded transparently by relay proxy handler"
  - "ToolApprovePayload extended with whitelistTool boolean for session-level auto-approval"
  - "RelayConnection.sendRaw added for handler modules to send pre-serialized messages"
  - "Proxy name defaults to hostname, overridable via CC_ANYWHERE_PROXY_NAME env var"
  - "Command discovery uses static builtin list, to be replaced by dynamic discovery in future plan"
metrics:
  duration: 22min
  completed: "2026-04-08T12:53:13Z"
  tasks: 2
  files: 12
---

# Phase 6 Plan 05: Relay Routing and Proxy Terminal Push Summary

Relay routes terminal_frame/pty_state envelopes and Phase 6 control messages bidirectionally; proxy pushes terminal frames with incremental line-level diff via extracted handler modules.

## What Was Done

### Task 1: Update relay to route new envelope types and control messages

**router.ts**: Changed `SNAPSHOT_TYPE` constant to `SNAPSHOT_TYPES` Set containing both `pty_snapshot` and `terminal_frame`, so terminal frames trigger buffer compression like PTY snapshots. Added D-32 documentation comment on `routeClientMessage` confirming tool_approve/tool_deny bypass queuing.

**handlers/proxy.ts**: Added forwarding for proxy-to-client relay control messages (`dir_list_response`, `command_list_push`, `file_tree_push`, `session_history_response`). Proxy sends these as relay control messages; relay recognizes them and forwards to all bound clients. Also updated `proxy_register` handling to extract and pass `name` field to registry.

**handlers/client.ts**: Added `dir_list_request` routing (forward to proxy by proxyId from message), `session_history_request` routing (forward to bound proxy), and updated `proxy_list_response` to use `registry.listProxiesWithName()` which includes the proxy name field.

**registry.ts**: Extended `ProxyState` with optional `name` field. Updated `registerProxy` to accept optional `name` parameter. Added `listProxiesWithName()` and `getProxyName()` methods.

**packages/shared/src/schemas/tool.ts**: Added `whitelistTool: z.boolean().optional()` to `ToolApprovePayloadSchema` for D-25/D-27 session-level tool whitelist protocol support.

All 124 relay tests pass (8 test files).

### Task 2: Extract proxy handlers into modules, implement incremental terminal push and control messages

**handlers/terminal-push.ts**: New module exporting `createTerminalPushHandler` factory. Implements 5fps (200ms interval) terminal frame push with incremental line-level diff. First frame sends `mode: "full"` with complete grid. Subsequent frames send `mode: "delta"` with only changed lines (lineIndex + spans). Skips push when `hasGridChanged()` returns false. Per-session state with deep grid cloning to avoid reference comparison issues.

**handlers/control-messages.ts**: New module exporting `createControlMessageHandlers` factory. Handles:
- `handleDirListRequest`: Path validation (T-06-13: reject non-absolute paths and path traversal), directory listing with dotfile filtering
- `handleSessionHistoryRequest`: Delegates to `scanSessionHistory()`
- `pushCommandList`: Static builtin commands with 6-hour refresh timer (D-28)
- `pushFileTree`: 2-level directory tree scan excluding dotfiles and node_modules
- `reinitializeOnReconnect` (D-41): Re-push command list and file tree for all active sessions
- `cleanup`: Clear timers per session

**session-history.ts**: New module exporting `scanSessionHistory()`. Scans `~/.claude/projects/` directory structure for Claude Code session metadata files. Extracts session ID (from filename), title (from JSON content), project directory (decoded from directory name), and updatedAt (from file mtime). Returns results sorted by updatedAt descending. Handles missing directories and malformed JSON gracefully.

**serve.ts**: Updated as composition root:
- Imports and creates `TerminalPushHandler` and `ControlMessageHandlers` with lazy-bound relay send
- D-23: Proxy name from `CC_ANYWHERE_PROXY_NAME` env or `os.hostname()`
- D-25/D-27: `tool_approve` handler checks `whitelistTool` field and sends `worker_whitelist_add` IPC
- Relay message dispatch extended for `dir_list_request` and `session_history_request`
- D-41: `connected` event triggers `reinitializeOnReconnect`
- Session termination and PTY deregister wired to handler cleanup
- Shutdown wired to `terminalPush.stopAll()`

**relay-connection.ts**: Added `sendRaw(raw: string)` method for handler modules to send pre-serialized messages. Added `name` option to `RelayConnectionOptions`, included in `proxy_register` message.

**Tests**: 7 test cases in `session-history.test.ts` (missing dir, empty dir, extraction, missing title, non-JSON skip, malformed JSON, sort order). 8 test cases in `terminal-push.test.ts` (full mode, delta mode, skip unchanged, stop clears interval, multiple sessions, new lines delta, interval constant). All 212 proxy tests pass (16 test files).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TerminalTracker lives in client process, not serve process**
- **Found during:** Task 2
- **Issue:** Plan says to wire `pty_register` to `terminalPush.start(sessionId, tracker)` in serve.ts, but the TerminalTracker is created in client.ts (the PTY client process), not in the service process. serve.ts has no direct access to PTY trackers.
- **Fix:** Created the TerminalPushHandler with full functionality and wired cleanup paths. The actual terminal push start will be connected when the architecture supports it (either by moving tracker to serve.ts or adding IPC for frame data). The handler module is ready and tested.
- **Files modified:** apps/proxy/src/serve.ts

**2. [Rule 2 - Missing] RelayConnection had no sendRaw method**
- **Found during:** Task 2
- **Issue:** Handler modules produce pre-serialized JSON strings, but RelayConnection.send() only accepted MessageEnvelope objects requiring re-serialization.
- **Fix:** Added `sendRaw(raw: string)` method to RelayConnection, refactored `send()` to delegate to it.
- **Files modified:** apps/proxy/src/relay-connection.ts

**3. [Rule 2 - Missing] Command discovery module did not exist**
- **Found during:** Task 2
- **Issue:** Plan references `discoverCommands(workDir)` but no command-discovery module exists in the codebase.
- **Fix:** Implemented inline static command list (builtin slash commands) in control-messages.ts. Future plans will replace with dynamic discovery.
- **Files modified:** apps/proxy/src/handlers/control-messages.ts

## Verification

- All 124 relay tests pass (8 test files)
- All 212 proxy tests pass (16 test files)
- router.ts contains `terminal_frame` in SNAPSHOT_TYPES set
- handlers/client.ts routes `dir_list_request` and `session_history_request`
- registry.ts stores proxy `name` field and returns it via `listProxiesWithName()`
- handlers/terminal-push.ts exports `createTerminalPushHandler` with full/delta/skip logic
- handlers/control-messages.ts exports `createControlMessageHandlers` with path validation
- session-history.ts exports `scanSessionHistory`
- serve.ts imports from handlers/ modules (composition root pattern)
- serve.ts contains `hostname()` for proxy name
- serve.ts contains `whitelistTool` handling

## Known Stubs

| File | Line | Description |
|------|------|-------------|
| handlers/control-messages.ts | discoverCommands() | Returns static builtin commands only. Dynamic discovery (scanning .claude/commands, project COMMANDS.md) deferred to future plan |
| serve.ts | terminalPush | Handler created but start() not wired for PTY sessions. Tracker lives in client process, needs architecture bridge |

## Self-Check: PENDING

Self-check pending git commit verification. All source files verified present on disk.
