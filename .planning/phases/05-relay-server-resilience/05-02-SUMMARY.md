---
phase: 05-relay-server-resilience
plan: 02
subsystem: relay, registry, buffer
tags: [session-buffer, fifo-eviction, compression, grace-period, proxy-state]

requires:
  - phase: 05-relay-server-resilience
    plan: 01
    provides: RelayControlSchema with Phase 5 control messages, MessageQueue, RelayConnection auto-reconnect
provides:
  - SessionBuffer class with per-session 1000-message FIFO eviction and seq-based retrieval
  - BufferCompressor with PTY snapshot and JSON result compression
  - RelayRegistry overhauled with ProxyState, grace period timers, per-session buffers, clientId-based bindings
  - Router buffers proxy messages per-session with compression triggers
  - Proxy handler sends proxy_offline notification and starts grace period on disconnect
  - /status endpoint reports buffer statistics
affects: [05-03, relay-server-resilience]

tech-stack:
  added: []
  patterns: [per-session-buffering, fifo-eviction, grace-period-lifecycle, buffer-compression]

key-files:
  created:
    - apps/relay/src/session-buffer.ts
    - apps/relay/src/buffer-compressor.ts
    - apps/relay/src/__tests__/session-buffer.test.ts
  modified:
    - apps/relay/src/registry.ts
    - apps/relay/src/router.ts
    - apps/relay/src/handlers/proxy.ts
    - apps/relay/src/server.ts
    - apps/relay/src/health.ts
    - apps/relay/src/__tests__/registry.test.ts
    - apps/relay/src/__tests__/server.test.ts

key-decisions:
  - "Grace period uses startGracePeriod instead of unregisterProxy on disconnect, preserving state for 30 minutes"
  - "SessionBuffer stores raw JSON + parsed metadata (seq, type, source) for efficient compression without re-parsing"
  - "Legacy WebSocket-based client binding preserved alongside new clientId-based binding for backward compatibility"
  - "Timer.unref() prevents grace period timers from blocking Node.js process exit"

patterns-established:
  - "ProxyState lifecycle: new -> online -> grace period (ws=null) -> reconnected or cleaned up"
  - "Buffer compression: snapshot discards pre-snapshot, result discards streaming deltas within turn"

requirements-completed: [RELAY-02, RELAY-04]

duration: 5min
completed: 2026-04-07
---

# Phase 5 Plan 02: Relay-Side Session Buffering & Grace Period Summary

**Per-session message buffering with FIFO eviction, PTY snapshot and JSON result compression, and 30-minute proxy grace period lifecycle**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-07T02:15:46Z
- **Completed:** 2026-04-07T02:21:05Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments

- Created SessionBuffer class with 1000-message FIFO eviction cap, seq-based range queries (getAfterSeq, getRange), and replaceable internals for compression
- Created BufferCompressor with compressOnSnapshot (discards all pre-snapshot messages) and compressOnResult (removes intermediate streaming deltas within a turn boundary)
- Overhauled RelayRegistry from simple Map-based to stateful ProxyState tracking with grace period timers, per-session buffer management, and dual client binding systems (clientId + legacy WebSocket)
- Integrated buffer into router: all proxy->client messages are buffered per-session before forwarding, with automatic compression on snapshot and result events
- Proxy disconnect now starts 30-minute grace period instead of immediate cleanup, with proxy_offline notification to all bound clients
- Server shutdown calls clearAllTimers to prevent timer leaks
- /status endpoint extended with buffer statistics (totalBuffered, sessionCount, proxyCount)

## Task Commits

1. **Task 1: SessionBuffer and BufferCompressor** - `561e7f3`
2. **Task 2: Registry overhaul with grace period, router buffer integration** - `d1069bc`

## Files Created/Modified

- `apps/relay/src/session-buffer.ts` - SessionBuffer class with FIFO eviction, seq queries, replaceMessages for compression
- `apps/relay/src/buffer-compressor.ts` - compressOnSnapshot and compressOnResult functions
- `apps/relay/src/__tests__/session-buffer.test.ts` - 17 tests for buffer ops, FIFO eviction, compression
- `apps/relay/src/registry.ts` - ProxyState interface, grace period lifecycle, per-session buffer management, clientId binding
- `apps/relay/src/router.ts` - Buffer integration with addSessionToProxy, getOrCreateSessionBuffer, compression triggers
- `apps/relay/src/handlers/proxy.ts` - Grace period on disconnect, proxy_offline notification to clients
- `apps/relay/src/server.ts` - clearAllTimers in close()
- `apps/relay/src/health.ts` - Buffer stats in /status response
- `apps/relay/src/__tests__/registry.test.ts` - 30 tests covering grace period, buffers, client binding, timers
- `apps/relay/src/__tests__/server.test.ts` - Updated 2 integration tests for grace period behavior

## Decisions Made

- Grace period uses startGracePeriod instead of unregisterProxy on disconnect, preserving all state (session buffers, client bindings) for 30 minutes to allow proxy reconnection
- SessionBuffer stores raw JSON string alongside parsed metadata (seq, type, source) to enable compression without re-parsing every message
- Legacy WebSocket-based client binding preserved alongside new clientId-based binding for backward compatibility with existing client handler
- Timer.unref() prevents grace period timers from blocking Node.js process exit

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated server integration tests for grace period behavior**
- **Found during:** Task 2 verification
- **Issue:** Two integration tests ("cleans up when proxy disconnects" and "detects and cleans up dead connections") expected proxy to be removed from listProxies() after disconnect. With grace period, proxy remains in list but with ws=null.
- **Fix:** Updated assertions to check that proxy remains in listProxies() but isProxyOnline() returns false
- **Files modified:** apps/relay/src/__tests__/server.test.ts
- **Committed in:** d1069bc

---

**Total deviations:** 1 auto-fixed (1 test adaptation for new behavior)
**Impact on plan:** Test adaptation only, production behavior exactly as planned.

## Issues Encountered
None.

## Next Phase Readiness
- SessionBuffer and per-session buffering ready for Plan 03's client reconnect and gap detection flow
- Grace period ensures proxy state survives temporary disconnections, enabling seamless reconnect in Plan 03
- Buffer compression prevents unbounded memory growth during long sessions
- /status endpoint provides operational visibility into buffer state

---
*Phase: 05-relay-server-resilience*
*Completed: 2026-04-07*
