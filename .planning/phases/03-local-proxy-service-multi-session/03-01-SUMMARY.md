---
phase: 03-local-proxy-service-multi-session
plan: 01
subsystem: proxy
tags: [node-streams, ndjson, zod, ipc, pty, multi-session]

requires:
  - phase: 02-local-proxy-pty-transparency
    provides: PtyManager with transparent PTY wrapping
provides:
  - LineBuffer Transform stream for splitting data events into complete lines
  - IPC protocol with 14 message types for Unix domain socket NDJSON communication
  - PtyManager refactored with onSessionExit callback (multi-session safe)
  - nanoid, pino, commander dependencies installed
affects: [03-02 (JsonSession uses LineBuffer), 03-03 (service/client use IPC protocol and PtyManager)]

tech-stack:
  added: [nanoid, pino, commander, zod (in proxy)]
  patterns: [NDJSON framing over Unix domain socket, LineBuffer for stream line splitting, callback-based exit for multi-session]

key-files:
  created:
    - apps/proxy/src/line-buffer.ts
    - apps/proxy/src/ipc-protocol.ts
    - apps/proxy/src/__tests__/line-buffer.test.ts
    - apps/proxy/src/__tests__/ipc-protocol.test.ts
  modified:
    - apps/proxy/src/pty-manager.ts
    - apps/proxy/src/__tests__/pty-manager.test.ts
    - apps/proxy/src/index.ts
    - apps/proxy/package.json

key-decisions:
  - "IPC uses NDJSON framing (JSON + newline) over Unix domain socket for simplicity and debuggability"
  - "PtyManager delegates exit handling to caller via onSessionExit callback, enabling multi-session mode"
  - "Global signal handlers removed from PtyManager -- caller responsibility in multi-session architecture"

patterns-established:
  - "LineBuffer pattern: use Transform stream to split arbitrary data chunks into complete lines before parsing"
  - "IPC protocol pattern: zod discriminatedUnion schema for typed NDJSON messages with serializeIpc/createIpcReader helpers"
  - "Callback-based exit: PtyManager.onSessionExit replaces process.exit for composable lifecycle management"

requirements-completed: [PROXY-02]

duration: 8min
completed: 2026-04-03
---

# Phase 3 Plan 01: Foundation Utilities Summary

**LineBuffer stream splitter, 14-type IPC protocol with NDJSON framing, and PtyManager refactored to callback-based exit for multi-session**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-03T17:05:15Z
- **Completed:** 2026-04-03T17:13:22Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- LineBuffer Transform stream correctly assembles split data chunks into complete newline-delimited lines with full edge case coverage
- IPC protocol defines 14 message types (session CRUD, PTY register/deregister/IO, heartbeat, status updates, errors) with zod schema validation and NDJSON serialization
- PtyManager no longer calls process.exit() or registers global signal handlers, using onSessionExit callback instead
- Phase 3 dependencies installed: nanoid, pino, commander, zod

## Task Commits

Each task was committed atomically:

1. **Task 1: LineBuffer + IPC protocol + dependencies** - `eb140d7` (feat)
2. **Task 2: PtyManager callback-based exit refactor** - `6ea4261` (refactor)

## Files Created/Modified
- `apps/proxy/src/line-buffer.ts` - Transform stream splitting data events into complete lines
- `apps/proxy/src/ipc-protocol.ts` - IPC message schema (14 types), NDJSON serialize/reader
- `apps/proxy/src/__tests__/line-buffer.test.ts` - 8 tests covering all stream splitting edge cases
- `apps/proxy/src/__tests__/ipc-protocol.test.ts` - 21 tests for serialization, reader, and schema validation
- `apps/proxy/src/pty-manager.ts` - Removed process.exit(), added onSessionExit callback, removed global handlers
- `apps/proxy/src/__tests__/pty-manager.test.ts` - Updated to test callback behavior, added no-crash and no-global-handler tests
- `apps/proxy/src/index.ts` - Added onSessionExit to maintain backward-compatible exit behavior
- `apps/proxy/package.json` - Added nanoid, pino, commander, zod dependencies

## Decisions Made
- IPC uses NDJSON framing (JSON + newline) over Unix domain socket for simplicity and debuggability
- PtyManager delegates exit handling to caller via onSessionExit callback, enabling multi-session mode
- Global signal handlers (SIGTERM, SIGHUP, uncaughtException, unhandledRejection) removed from PtyManager -- caller's responsibility in multi-session architecture

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added onSessionExit to index.ts entry point**
- **Found during:** Task 2 (PtyManager refactor)
- **Issue:** After removing process.exit() from PtyManager, the main entry point would hang after claude exits because no onSessionExit callback was provided
- **Fix:** Added `onSessionExit: (code) => process.exit(code)` to PtyManager constructor in index.ts
- **Files modified:** apps/proxy/src/index.ts
- **Verification:** TypeScript compiles, build succeeds
- **Committed in:** 6ea4261 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential fix to maintain working CLI behavior after refactor. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- LineBuffer ready for JsonSession (Plan 02) to use for stream-json output parsing
- IPC protocol ready for service.ts and client.ts (Plan 03) to use for Unix domain socket communication
- PtyManager ready for client.ts (Plan 03) to wrap with session lifecycle management
- All 39 tests passing, TypeScript clean, build succeeds

## Self-Check: PASSED

All 8 files verified present. Both commit hashes (eb140d7, 6ea4261) verified in git log.

---
*Phase: 03-local-proxy-service-multi-session*
*Completed: 2026-04-03*
