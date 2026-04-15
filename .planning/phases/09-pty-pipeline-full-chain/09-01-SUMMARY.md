---
phase: 09-pty-pipeline-full-chain
plan: 01
subsystem: proxy
tags: [eventstore, ccae, binary, headless-xterm, pipeline-migration]
dependency_graph:
  requires: []
  provides: [EventStore, CCAE-binary-format, headless-xterm-snapshots]
  affects: [apps/proxy/src/terminal.ts, apps/proxy/src/serve.ts]
tech_stack:
  added: []
  patterns: [CCAE-binary-format, reverse-scan, gzip-rotation, headless-serialize-snapshot]
key_files:
  created:
    - apps/proxy/src/event-store.ts
    - apps/proxy/src/__tests__/unit/event-store.test.ts
  modified:
    - apps/proxy/src/terminal.ts
    - apps/proxy/src/replay.ts
    - apps/proxy/src/serve.ts
    - apps/proxy/src/index.ts
    - apps/proxy/src/handlers/control-messages.ts
    - apps/proxy/src/__tests__/unit/terminal-data-flow.test.ts
    - apps/proxy/src/__tests__/integration/terminal-e2e.test.ts
    - apps/proxy/src/__tests__/unit/control-messages.test.ts
  deleted:
    - apps/proxy/src/terminal-tracker.ts
    - apps/proxy/src/frame-pusher.ts
    - apps/proxy/src/frame-cache.ts
    - apps/proxy/src/terminal-frame-renderer.ts
    - apps/proxy/src/__tests__/unit/frame-cache.test.ts
    - apps/proxy/src/__tests__/unit/frame-pusher.test.ts
    - apps/proxy/src/__tests__/unit/terminal-frame-renderer.test.ts
decisions:
  - "writeSync on pre-opened fd for immediate persistence (D-02 compliance)"
  - "allowProposedApi: true required for @xterm/addon-serialize on @xterm/headless 6.0.0"
  - "terminal.write() is async in headless mode, requires callback-based Promise wrapper"
  - "replay.ts stubbed with throw -- full migration deferred to Plan 09-02/03"
  - "serve.ts frameCache removed entirely, terminal_frame_request handler simplified"
metrics:
  duration: 12min
  completed: "2026-04-15T15:19:59Z"
  tasks: 2
  files_changed: 15
  lines_added: 1021
  lines_deleted: 2491
---

# Phase 09 Plan 01: EventStore + Headless Pipeline Foundation Summary

CCAE binary EventStore with immediate write, reverse-scan snapshot recovery, gzip rotation; terminal.ts rewritten to use @xterm/headless + EventStore replacing TerminalTracker + FramePusher + FrameCache pipeline (~2500 lines deleted).

## What Was Built

### Task 1: EventStore with CCAE Binary Format (a79af67)

Created `apps/proxy/src/event-store.ts` implementing the full CCAE binary event persistence layer:

- **File header**: 6 bytes (4B 'CCAE' magic + 2B version uint16LE)
- **Event structure**: [1B type][8B timestamp float64LE][4B payload_len uint32LE][NB payload][4B total_len uint32LE trailer]
- **Event types**: PTY_DATA (0x01), SNAPSHOT (0x02), RESIZE (0x03), METADATA (0x04)
- **Write strategy**: `writeSync` on pre-opened fd for D-02 immediate persistence
- **Reverse scan**: `findLatestSnapshot()` reads from file tail using total_len trailers
- **Rotation**: gzip compression to numbered archives (events.001.bin.gz, .002, .003...)
- **Session close**: archives remaining active file to events.bin.gz

21 unit tests covering encode/decode, write/read, reverse scan, rotation, gzip archival.

### Task 2: Headless + EventStore Integration, Old Pipeline Deletion (e3bbf2a)

**terminal.ts rewrite**: Replaced TerminalTracker + FramePusher with @xterm/headless + SerializeAddon + EventStore. New PTY onData flow:
1. `process.stdout.write(data)` -- sync, local terminal priority (D-14)
2. `headlessTerminal.write(data)` -- headless state tracking
3. `eventStore.appendPtyData(data)` -- immediate disk write (D-02)
4. JSON IPC frame push (temporary, Plan 02 replaces with binary IPC)
5. `eventStore.shouldSnapshot()` check -> `serializeAddon.serialize()` -> `eventStore.appendSnapshot()`

**Files deleted** (7 source + test files, ~2491 lines removed):
- terminal-tracker.ts (379 lines) -- replaced by @xterm/headless
- frame-pusher.ts (116 lines) -- replaced by binary IPC (Plan 02)
- frame-cache.ts (67 lines) -- no longer needed with EventStore snapshots
- terminal-frame-renderer.ts (158 lines) -- replaced by xterm.js browser rendering
- frame-cache.test.ts, frame-pusher.test.ts, terminal-frame-renderer.test.ts

**Tests rewritten**: terminal-data-flow.test.ts and terminal-e2e.test.ts now verify headless terminal + serialize + EventStore pipeline.

**serve.ts cleanup**: Removed FrameCache import and all frameCache references. Simplified terminal_frame_request handler.

**replay.ts**: Stubbed with `throw new Error("replay not yet migrated to v2 pipeline")`.

**control-messages.ts**: Removed `registerTracker` method and TerminalTracker type import.

**index.ts**: Removed TerminalTracker from record command.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added allowProposedApi: true to HeadlessTerminal**
- **Found during:** Task 2 test execution
- **Issue:** @xterm/addon-serialize requires `allowProposedApi: true` on Terminal instances (xterm 6.0.0). Tests failed with "You must set the allowProposedApi option to true to use proposed API"
- **Fix:** Added `allowProposedApi: true` to all HeadlessTerminal constructors in terminal.ts and test files
- **Files modified:** terminal.ts, terminal-data-flow.test.ts, terminal-e2e.test.ts
- **Commit:** e3bbf2a

**2. [Rule 1 - Bug] Async terminal.write() in headless mode**
- **Found during:** Task 2 test execution
- **Issue:** `terminal.write()` in @xterm/headless is asynchronous -- data not immediately available for `serialize()`. Old TerminalTracker used callback form.
- **Fix:** Created `termWrite()` helper wrapping write in Promise with callback, made all test cases async/await
- **Files modified:** terminal-data-flow.test.ts, terminal-e2e.test.ts
- **Commit:** e3bbf2a

**3. [Rule 1 - Bug] Lint errors: unused imports**
- **Found during:** Task 1 commit (pre-commit hook)
- **Issue:** Unused imports (renameSync, log in event-store.ts; readdirSync, writeFileSync in test)
- **Fix:** Removed unused imports
- **Files modified:** event-store.ts, event-store.test.ts
- **Commit:** a79af67 (amended)

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| `writeSync` on pre-opened fd | D-02 requires immediate persistence; writeSync on open fd costs only actual I/O, no open/close overhead |
| `allowProposedApi: true` | Required by @xterm/addon-serialize 0.14.0 for buffer access in xterm 6.0.0 |
| Callback-based Promise for terminal.write | headless terminal write is async; wrapping in Promise enables clean test flow |
| Stub replay.ts with throw | replay depends on binary IPC (Plan 02) and browser rendering (Plan 03); clean stub keeps build green |
| Remove frameCache entirely from serve.ts | Frame cache concept is replaced by EventStore snapshot recovery in Phase 9 |

## Verification Results

- `pnpm --filter proxy build` -- passed (ESM build success)
- `pnpm --filter proxy exec vitest run` -- 230 tests passed across 16 files
- `pnpm lint` -- no errors
- No references to TerminalTracker/FramePusher/FrameCache/TerminalFrameRenderer in proxy source

## Self-Check: PASSED

- All created files exist (event-store.ts, event-store.test.ts)
- All 7 deleted files confirmed absent
- Both commits found (a79af67, e3bbf2a)
- Build passes, 230/230 tests pass, lint clean
