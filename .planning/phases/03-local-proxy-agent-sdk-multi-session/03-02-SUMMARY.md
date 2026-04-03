---
phase: 03-local-proxy-agent-sdk-multi-session
plan: 02
subsystem: proxy
tags: [session-manager, json-session, stream-json, nanoid, multi-session, tool-approval, process-management]

requires:
  - phase: 03-01
    provides: "LineBuffer, IPC protocol, PtyManager with onSessionExit callback"
  - phase: 01
    provides: "Shared package with SessionState constants and session schemas"
provides:
  - "SessionManager class with Map-based registry, CRUD API, JSON persistence, heartbeat tracking, reaper timer"
  - "JsonSession class managing a claude --stream-json child process with event parsing, stdin write queue, and tool approval"
affects: [03-03, relay-server, feishu-mini-program]

tech-stack:
  added: [nanoid]
  patterns: [state-machine-transitions, atomic-file-write, write-queue-serialization, injectable-strategy-pattern, process-reaper]

key-files:
  created:
    - apps/proxy/src/session-manager.ts
    - apps/proxy/src/json-session.ts
    - apps/proxy/src/__tests__/session-manager.test.ts
    - apps/proxy/src/__tests__/json-session.test.ts
  modified: []

key-decisions:
  - "State machine rejects error->idle transition; error is recoverable only via terminated"
  - "Terminated sessions filtered on load from persistence file to avoid stale data accumulation"
  - "Default deny-all tool approval strategy as security-first default before remote approval is wired"

patterns-established:
  - "Atomic file write: write to .tmp then rename for crash safety"
  - "Write queue serialization: chain promises to prevent interleaved stdin writes"
  - "Injectable strategy pattern: ApprovalStrategy function injection for tool approval"
  - "State transition table: explicit allowed-transitions map with terminal state enforcement"

requirements-completed: [PROXY-02, PROXY-03]

duration: 6min
completed: 2026-04-03
---

# Phase 03 Plan 02: SessionManager and JsonSession Summary

**Multi-session registry with JSON persistence and reaper, plus claude --stream-json process wrapper with deny-all tool approval and serialized stdin writes**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-03T17:18:08Z
- **Completed:** 2026-04-03T17:24:29Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- SessionManager provides full session lifecycle: create with nanoid IDs, list/get/terminate, state machine with transition validation, JSON persistence with atomic writes, heartbeat tracking, and process reaper
- JsonSession spawns claude --stream-json, parses structured events via LineBuffer, handles control_request with injectable approval strategy (deny-all default), serializes stdin writes via promise queue
- 41 new tests (session-manager) + 20 new tests (json-session) = 61 new tests, all 100 proxy tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: SessionManager** - `4b58aea` (test: failing tests) -> `8862e20` (feat: implementation)
2. **Task 2: JsonSession** - `e72216d` (test: failing tests) -> `f177f66` (feat: implementation)

_TDD workflow: RED (failing tests) then GREEN (implementation) for both tasks._

## Files Created/Modified
- `apps/proxy/src/session-manager.ts` - SessionManager class with Map-based registry, CRUD API, state machine, JSON persistence, heartbeat, reaper
- `apps/proxy/src/json-session.ts` - JsonSession class wrapping claude --stream-json child process with event parsing, tool approval, stdin write queue
- `apps/proxy/src/__tests__/session-manager.test.ts` - 41 tests covering CRUD, state transitions, persistence, heartbeat, reaper
- `apps/proxy/src/__tests__/json-session.test.ts` - 20 tests covering spawn, event parsing, tool approval, write queue, stop/isAlive

## Decisions Made
- State machine enforces strict transitions: terminated is terminal (no transitions out), error can only go to terminated (not back to idle)
- Terminated sessions are filtered out on persistence load to prevent stale data buildup after restart
- Default deny-all approval strategy as security baseline before remote approval pipeline is connected
- CLAUDECODE env vars are filtered from child process environment to prevent the spawned claude from inheriting proxy internals

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed flaky session ordering test**
- **Found during:** Task 2 (test suite run)
- **Issue:** `Date.now()` returns identical timestamps for rapidly created sessions, making sort order indeterminate
- **Fix:** Manually set distinct `createdAt` values in the test to ensure deterministic ordering
- **Files modified:** `apps/proxy/src/__tests__/session-manager.test.ts`
- **Verification:** Test passes reliably across runs
- **Committed in:** `f177f66` (part of Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Test reliability fix only, no scope change.

## Issues Encountered
- Shared package (`@cc-anywhere/shared`) dist not built in worktree, causing import resolution failures. Fixed by running `pnpm --filter @cc-anywhere/shared build` before tests.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- SessionManager and JsonSession are ready for Plan 03 (IPC server integration)
- Plan 03 will wire SessionManager into the IPC server, connecting create/list/terminate commands to actual session lifecycle
- JsonSession's onEvent callback is ready to be connected to relay forwarding in later phases

---
## Self-Check: PASSED

All 5 files verified present. All 4 commit hashes verified in git log. No stubs detected.

---
*Phase: 03-local-proxy-agent-sdk-multi-session*
*Completed: 2026-04-03*
