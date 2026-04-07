---
phase: 05-relay-server-resilience
verified: 2026-04-07T10:50:00Z
status: human_needed
score: 4/4 must-haves verified
gaps: []
human_verification:
  - test: "Start relay server, connect proxy, disconnect proxy (kill process), verify proxy auto-reconnects and resumes session"
    expected: "Proxy reconnects within seconds with exponential backoff, re-registers with same proxyId, queued messages are flushed"
    why_human: "Requires running two processes (relay + proxy) and simulating network disruption; cannot verify end-to-end timing and behavior programmatically"
  - test: "Connect client via WebSocket, send proxy messages, disconnect client, reconnect client with client_register and lastSeq, verify missed messages arrive"
    expected: "Client receives client_register_response with status 'restored' and missed messages are streamed individually"
    why_human: "Requires running relay server and simulating client WebSocket lifecycle; integration tests cover this partially but full end-to-end with real timing needs manual verification"
  - test: "Disconnect proxy while client is connected, verify client receives proxy_offline notification, then reconnect proxy, verify client can resume"
    expected: "Client receives proxy_offline message; after proxy reconnects and client re-registers, status is 'restored'"
    why_human: "Multi-party coordination (proxy + relay + client) with timing-sensitive state transitions"
---

# Phase 5: Relay Server - Resilience Verification Report

**Phase Goal:** The relay handles real-world network instability without losing messages or breaking sessions
**Verified:** 2026-04-07T10:50:00Z
**Status:** human_needed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | When proxy loses connection, it automatically reconnects with exponential backoff and resumes the session | VERIFIED | `relay-connection.ts` contains `scheduleReconnect()` with full jitter exponential backoff (`Math.random() * Math.min(30000, 1000 * Math.pow(2, attempt))`), `doConnect()` re-sends `proxy_register` with original `proxyId`, `connected` event emitted after queue flush. Integration test "reconnects automatically after unexpected close" passes. |
| 2 | Messages sent during a disconnection are queued and delivered after reconnection (no silent message loss) | VERIFIED | `relay-connection.ts:send()` queues via `this.queue.enqueue(raw)` when `ws.readyState !== OPEN`; `flushQueue()` drains all items on reconnect before emitting `connected`. `MemoryMessageQueue` in `message-queue.ts` implements FIFO with `enqueue/drain/size/clear`. Integration test "flushes queued messages on reconnect" passes. |
| 3 | When Feishu mini program goes to background and its WebSocket drops, the relay buffers messages and replays them on reconnection | VERIFIED | `router.ts:routeProxyMessage()` buffers every proxy message to per-session `SessionBuffer` before forwarding. `handlers/client.ts:handleClientRegister()` implements 3-way status (restored/proxy_offline/new); on `restored`, iterates proxy sessions and calls `buffer.getAfterSeq(lastSeq)` to stream missed messages individually. `handleReplayRequest()` in `router.ts` serves explicit seq range requests. 12 integration tests (7 client_register + 5 replay) pass. |
| 4 | After reconnection, both proxy and client receive only the messages they missed (no duplicates, no gaps) | VERIFIED | Proxy-side: `MessageQueue.drain()` returns and clears all items atomically (no duplicates). Client-side: `getAfterSeq(lastSeq)` returns only messages with `seq > lastSeq` (no duplicates, seq-based). `getRange(fromSeq, toSeq)` for replay_request returns exact range. `gap_unrecoverable` sent when buffer doesn't cover requested range. SessionBuffer FIFO eviction at 1000 cap with `compressOnSnapshot` and `compressOnResult` compression prevent unbounded growth while preserving essential state. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/shared/src/schemas/relay-control.ts` | 6 new Phase 5 control message types | VERIFIED | Contains `client_register`, `client_register_response`, `replay_request`, `replay_response`, `gap_unrecoverable`, `proxy_offline` with full zod validation. 11 total variants (5 Phase 4 + 6 Phase 5). |
| `apps/proxy/src/message-queue.ts` | MessageQueue interface + MemoryMessageQueue | VERIFIED | Exports `MessageQueue` interface and `MemoryMessageQueue` class with `enqueue/drain/size/clear`. 29 lines, clean implementation. |
| `apps/proxy/src/relay-connection.ts` | Auto-reconnect with exponential backoff, queue integration | VERIFIED | Contains `scheduleReconnect()`, `doConnect()`, `flushQueue()`, `MemoryMessageQueue` import, `closed` flag for intentional close, `connected`/`disconnected` events. 158 lines. |
| `apps/relay/src/session-buffer.ts` | Per-session message buffer with FIFO eviction | VERIFIED | `SessionBuffer` class with 1000-message cap, `append/getAfterSeq/getRange/getAll/replaceMessages/size/clear`. `BufferedMessage` interface with `raw/seq/type/source`. 51 lines. |
| `apps/relay/src/buffer-compressor.ts` | PTY snapshot and JSON result compression | VERIFIED | `compressOnSnapshot()` removes pre-snapshot messages. `compressOnResult()` removes streaming deltas (`assistant_message`, `thinking`) within turn boundary. 48 lines. |
| `apps/relay/src/registry.ts` | Extended registry with grace period, per-session buffers, clientId bindings | VERIFIED | `ProxyState` interface with `ws/sessions/graceTimer/disconnectedAt`. `startGracePeriod()` with 30-min timeout and `timer.unref()`. `cleanupProxy()` removes buffers and bindings. `bindClientById/updateClientSocket/unbindClientById` for clientId-based binding. `getBufferStats()` for /status. `clearAllTimers()` for shutdown. 261 lines. |
| `apps/relay/src/router.ts` | Buffer integration + handleReplayRequest | VERIFIED | `routeProxyMessage()` buffers to per-session buffer before forwarding, triggers `compressOnSnapshot`/`compressOnResult`. `handleReplayRequest()` serves buffered range with `gap_unrecoverable` fallback. 193 lines. |
| `apps/relay/src/handlers/proxy.ts` | Grace period on disconnect, proxy_offline notification | VERIFIED | `close` handler sends `proxy_offline` to all bound clients, calls `registry.startGracePeriod()`. Captures `registerProxy()` return value for logging. |
| `apps/relay/src/handlers/client.ts` | client_register protocol, replay_request routing | VERIFIED | `handleClientRegister()` with 3-way status. `replay_request` routed to `handleReplayRequest`. `ClientSocket` extended with `clientId`. `unbindClientById` on close preserves binding. |
| `apps/relay/src/server.ts` | clearAllTimers on shutdown | VERIFIED | `close()` calls `registry.clearAllTimers()` before terminating WebSockets. |
| `apps/relay/src/health.ts` | Buffer stats in /status | VERIFIED | `/status` endpoint returns `buffers: registry.getBufferStats()` with `totalBuffered/sessionCount/proxyCount`. |
| `apps/relay/src/__tests__/client-register.test.ts` | Integration tests for client_register | VERIFIED | 7 tests: new/restored/restored-with-replay/proxy_offline/grace-period-error/proxy_select-backward-compat. |
| `apps/relay/src/__tests__/replay.test.ts` | Integration tests for replay_request | VERIFIED | 5 tests: successful replay/partial-with-gap/fully-missing/unknown-session/invalid-range. |
| `apps/relay/src/__tests__/session-buffer.test.ts` | Tests for SessionBuffer and compression | VERIFIED | 17 tests covering buffer ops, FIFO eviction, compressOnSnapshot, compressOnResult. |
| `apps/relay/src/__tests__/registry.test.ts` | Tests for extended registry | VERIFIED | 30 tests covering grace period, buffers, client binding, timers, stats. |
| `apps/proxy/src/__tests__/message-queue.test.ts` | Tests for MemoryMessageQueue | VERIFIED | 5 tests: enqueue/drain ordering, drain empties, clear, multi-cycle. |
| `apps/proxy/src/__tests__/relay-connection.test.ts` | Tests for auto-reconnect and queue | VERIFIED | 12 tests including reconnect, queue, close, flush-on-reconnect. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `relay-connection.ts` | `message-queue.ts` | `import MemoryMessageQueue` | WIRED | Line 8: `import { MemoryMessageQueue } from "./message-queue.js"`. Used in `send()` queue.enqueue, `flushQueue()` queue.drain. |
| `router.ts` | `session-buffer.ts` | `buffer.append()` before forwarding | WIRED | `routeProxyMessage()` calls `registry.getOrCreateSessionBuffer(sessionId)` then `buffer.append()` at line 72. |
| `router.ts` | `buffer-compressor.ts` | `compressOnSnapshot/compressOnResult` | WIRED | Line 10: import. Lines 76-79: triggered on SNAPSHOT_TYPE and RESULT_TYPE. |
| `handlers/proxy.ts` | `registry.ts` | `startGracePeriod` on disconnect | WIRED | Line 71: `registry.startGracePeriod(proxyWs.proxyId)` in close handler. |
| `handlers/proxy.ts` | `registry.ts` | `registerProxy` with status | WIRED | Line 31: `const status = registry.registerProxy(proxyId, proxyWs)`. |
| `handlers/client.ts` | `registry.ts` | `getClientBinding/bindClientById/isProxyOnline` | WIRED | `handleClientRegister()` calls `getClientBinding`, `updateClientSocket`, `isProxyOnline`, `getSessionsForProxy`, `getSessionBuffer`. |
| `handlers/client.ts` | `router.ts` | `handleReplayRequest` import | WIRED | Line 5: `import { parseMessage, routeClientMessage, handleReplayRequest } from "../router.js"`. Used at line 95. |
| `server.ts` | `registry.ts` | `clearAllTimers` on shutdown | WIRED | Line 74: `registry.clearAllTimers()` in `close()`. |
| `health.ts` | `registry.ts` | `getBufferStats` for /status | WIRED | Line 16: `const bufferStats = registry.getBufferStats()`. |

### Data-Flow Trace (Level 4)

Not applicable -- Phase 5 artifacts are server-side infrastructure (message buffering, reconnection protocol). They do not render dynamic data to a UI. Data flows verified through key link wiring above.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Shared package tests pass | `pnpm --filter @cc-anywhere/shared exec vitest run` | 7 files, 119 tests passed | PASS |
| Proxy package tests pass | `pnpm --filter @cc-anywhere/proxy exec vitest run` | 9 files, 152 tests passed | PASS |
| Relay package tests pass | `pnpm --filter @cc-anywhere/relay exec vitest run` | 6 files, 79 tests passed | PASS |
| Workspace build succeeds | `pnpm build` | All packages built successfully | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| RELAY-02 | 05-01, 05-02 | Auto-reconnect (exponential backoff), disconnection message queue, session state recovery | SATISFIED | Proxy auto-reconnects with full jitter exponential backoff (1s base, 30s cap, infinite retry). MemoryMessageQueue buffers during disconnect, flushes on reconnect. Relay grace period (30 min) preserves state for proxy reconnection. |
| RELAY-04 | 05-02, 05-03 | Feishu mini program background destroy buffering, reconnect replay of missed messages | SATISFIED | Per-session SessionBuffer (1000-cap FIFO) stores all proxy messages. client_register protocol with 3-way status restores client binding. getAfterSeq(lastSeq) streams missed messages. replay_request/gap_unrecoverable for explicit gap recovery. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none found) | - | - | - | - |

No TODO/FIXME/PLACEHOLDER markers, no console.log in production code, no stub implementations, no empty returns in data-serving paths.

### Human Verification Required

### 1. End-to-End Proxy Reconnection

**Test:** Start relay server (`pnpm --filter @cc-anywhere/relay dev`), start proxy with relay URL, create a session, kill the relay process, wait 2-3 seconds, restart relay, verify proxy reconnects and messages resume.
**Expected:** Proxy logs show "Scheduling reconnect" with increasing backoff, then "Connected to relay server" on reconnect, followed by queue flush. Session continues without interruption.
**Why human:** Requires running multiple processes and simulating real network disruption timing.

### 2. Client Reconnection with Replay

**Test:** Connect a WebSocket client to `/client`, bind to proxy, have proxy send several messages, disconnect client WebSocket, reconnect with `client_register(clientId, lastSeq)`, verify missed messages arrive.
**Expected:** `client_register_response` with status "restored", followed by individual MessageEnvelope frames for messages with seq > lastSeq.
**Why human:** Multi-process coordination with timing-sensitive WebSocket lifecycle; integration tests cover the protocol but not real-world timing.

### 3. Grace Period Behavior

**Test:** Disconnect proxy while client is connected, verify client receives `proxy_offline`, wait briefly, reconnect proxy, have client re-register, verify status "restored".
**Expected:** Client gets `proxy_offline` immediately on proxy disconnect. Proxy reconnects within grace period. Client re-registers and gets "restored" with missed messages.
**Why human:** Three-party coordination with grace period timer interactions.

### Gaps Summary

No gaps found. All 4 roadmap success criteria are verified through code inspection and automated tests:

1. **Proxy auto-reconnect with exponential backoff** -- Implemented in `RelayConnection` with full jitter, infinite retry, queue integration, and re-registration. 12 relay-connection tests pass.
2. **Message queuing during disconnection** -- `MemoryMessageQueue` with FIFO ordering, `send()` auto-queues when offline, `flushQueue()` drains on reconnect. 5 message-queue tests pass.
3. **Relay buffers messages for disconnected clients** -- Per-session `SessionBuffer` with 1000-cap FIFO eviction, compression on snapshot/result events. Router buffers before forwarding. 17 session-buffer tests pass.
4. **Client reconnection with incremental replay** -- `client_register` 3-way protocol, `getAfterSeq(lastSeq)` streaming, `replay_request`/`gap_unrecoverable` for gap recovery. 12 integration tests pass.

Requirements RELAY-02 and RELAY-04 are both satisfied. Total test count: 350 tests across workspace (119 shared + 152 proxy + 79 relay), all passing.

---

_Verified: 2026-04-07T10:50:00Z_
_Verifier: Claude (gsd-verifier)_
