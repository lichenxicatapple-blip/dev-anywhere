---
phase: 09-pty-pipeline-full-chain
plan: 02
subsystem: proxy
tags: [binary-ipc, mixed-protocol, websocket-binary, relay-connection, pty-pipeline]
dependency_graph:
  requires:
    - phase: 09-01
      provides: EventStore, headless-xterm-snapshots, old-pipeline-deletion
  provides:
    - mixed-NDJSON-binary-IPC-protocol
    - RelayConnection-sendBinary-sendEnvelope
    - binary-PTY-forwarding-serve-to-relay
  affects: [09-03, 09-04, apps/relay/src/handlers/proxy.ts]
tech_stack:
  added: []
  patterns: [mixed-protocol-state-machine, binary-frame-marker-0x00, drop-on-disconnect]
key_files:
  created: []
  modified:
    - apps/proxy/src/ipc-protocol.ts
    - apps/proxy/src/relay-connection.ts
    - apps/proxy/src/serve.ts
    - apps/proxy/src/terminal.ts
    - apps/proxy/src/__tests__/unit/ipc-protocol.test.ts
    - apps/proxy/src/__tests__/integration/relay-connection.test.ts
key_decisions:
  - "createIpcReader rewritten as Buffer state machine instead of LineBuffer pipe"
  - "Binary frames dropped silently when no onBinaryFrame callback (backward compat)"
  - "sendBinary drops on disconnect, no queue (D-46 compliance)"
  - "terminal_frame_request and terminal_scroll_request converted to no-ops"
patterns-established:
  - "IPC mixed protocol: 0x00 marker for binary, '{' for JSON lines"
  - "RelayConnection dual-send: sendEnvelope() with queue, sendBinary() without"
requirements-completed: [PTY-03]
metrics:
  duration: 8min
  completed: "2026-04-15T15:33:02Z"
  tasks: 2
  files_changed: 6
  lines_added: 274
  lines_deleted: 67
---

# Phase 09 Plan 02: IPC Mixed Protocol + Binary Transport Pipeline Summary

Mixed NDJSON + binary IPC protocol with 0x00 marker byte state machine; RelayConnection sendEnvelope()/sendBinary() dual-method split; binary PTY data flows terminal.ts -> serve.ts -> relay via binary WebSocket frames.

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-15T15:24:13Z
- **Completed:** 2026-04-15T15:33:02Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- IPC protocol extended to handle mixed binary + NDJSON on same Unix socket using 0x00 marker byte discrimination
- RelayConnection renamed send() to sendEnvelope() and added sendBinary() for binary PTY frames (no queue, drop on disconnect)
- serve.ts receives binary IPC frames from terminal via onBinaryFrame callback and forwards to relay as binary WebSocket frames
- terminal.ts sends raw PTY data as binary IPC frames instead of JSON-wrapped terminal_frame messages

## Task Commits

1. **Task 1: IPC mixed protocol + binary frame encode/decode** - `df300d3` (feat, TDD)
2. **Task 2: RelayConnection sendBinary + serve.ts binary forwarding + terminal.ts binary IPC** - `e5a9eaf` (feat)

## Files Created/Modified
- `apps/proxy/src/ipc-protocol.ts` - Added encodeBinaryIpcFrame(), IPC_BINARY_MARKER, rewrote createIpcReader as Buffer state machine
- `apps/proxy/src/relay-connection.ts` - Renamed send() to sendEnvelope(), added sendBinary()
- `apps/proxy/src/serve.ts` - Added onBinaryFrame callback for binary relay forwarding, removed pty_terminal_frame handler
- `apps/proxy/src/terminal.ts` - Replaced JSON pty_terminal_frame with encodeBinaryIpcFrame()
- `apps/proxy/src/__tests__/unit/ipc-protocol.test.ts` - 7 new binary frame tests (encode, decode, chunk splitting, mixed streams)
- `apps/proxy/src/__tests__/integration/relay-connection.test.ts` - Updated send() calls to sendEnvelope()

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Rewrite createIpcReader as Buffer state machine | LineBuffer (Transform stream pipe) cannot handle mixed binary+text; raw Buffer accumulation with peek-first-byte discrimination is simpler and correct |
| Binary frames dropped silently without callback | Backward compatibility: existing callers using createIpcReader(stream, handler) continue to work unchanged |
| sendBinary() has no queue | D-46: binary PTY data is ephemeral, queuing stale terminal output wastes memory and creates confusing replay on reconnect |
| Keep pty_terminal_frame in IPC schema | Schema removal could break during rolling deployment; handler removal is sufficient |
| terminal_frame_request/scroll_request as no-ops | Phase 9 delegates scrollback to client xterm.js; recovery protocol comes in Phase 11 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Renamed send() to sendEnvelope() in relay-connection integration tests**
- **Found during:** Task 2 (test run)
- **Issue:** relay-connection.test.ts called conn.send() which no longer exists after rename
- **Fix:** Updated 3 call sites to conn.sendEnvelope()
- **Files modified:** apps/proxy/src/__tests__/integration/relay-connection.test.ts
- **Committed in:** e5a9eaf

---

**Total deviations:** 1 auto-fixed (1 bug from rename)
**Impact on plan:** Necessary fix for test correctness after method rename. No scope creep.

## Issues Encountered
None.

## Verification Results

- `pnpm --filter proxy build` -- passed (ESM build success)
- `pnpm --filter proxy exec vitest run` -- 237 tests passed across 16 files
- All acceptance criteria met:
  - ipc-protocol.ts exports encodeBinaryIpcFrame and IPC_BINARY_MARKER
  - createIpcReader accepts optional onBinaryFrame callback
  - relay-connection.ts has sendEnvelope() and sendBinary() methods
  - sendBinary() does NOT queue (drops on disconnect)
  - serve.ts does NOT import frame-cache
  - serve.ts calls relayConnection.sendEnvelope() (not .send())
  - serve.ts has onBinaryFrame callback in createIpcReader call
  - terminal.ts calls encodeBinaryIpcFrame for PTY data

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Binary PTY data now flows from terminal.ts through IPC to serve.ts and out to relay via binary WebSocket frames
- Plan 09-03 (relay binary passthrough + browser xterm.js) can consume these binary frames
- relay-side handler (apps/relay/src/handlers/proxy.ts) needs to detect binary messages and forward to client

## Self-Check: PASSED

- All modified files exist on disk
- Both commits found: df300d3, e5a9eaf
- All exports verified: encodeBinaryIpcFrame, IPC_BINARY_MARKER, sendEnvelope, sendBinary
- onBinaryFrame callback present in serve.ts createIpcReader call (line 600)
- encodeBinaryIpcFrame called in terminal.ts
- Build passes, 237/237 tests pass

---
*Phase: 09-pty-pipeline-full-chain*
*Completed: 2026-04-15*
