---
phase: 06-feishu-mini-program-core-interaction
plan: 01
subsystem: protocol
tags: [zod, schemas, terminal-frame, pty-state, relay-control, websocket-protocol]

requires:
  - phase: 05-relay-resilience
    provides: RelayControlSchema with client_register, replay, gap_unrecoverable, proxy_offline/online
provides:
  - TermSpanSchema and TerminalFramePayloadSchema for terminal grid rendering
  - PtyStatePayloadSchema for semantic PTY state events
  - SessionCreatePayload.cwd for remote directory selection
  - SessionListPayload.mode for pty/json mode visibility
  - terminal_frame and pty_state envelope types in MessageEnvelopeSchema (18 total)
  - dir_list_request/response for directory browsing
  - command_list_push for slash command discovery
  - file_tree_push for file tree display
  - session_history_request/response for session history browsing
  - proxy_register.name and proxy_list_response.name for proxy naming
affects: [06-02, 06-03, 06-04, 06-05, 06-06, 06-07, 06-08, 06-09, 06-10, 06-11]

tech-stack:
  added: []
  patterns: [inline source enum override for relay-sourced envelope types]

key-files:
  created: []
  modified:
    - packages/shared/src/schemas/session.ts
    - packages/shared/src/schemas/envelope.ts
    - packages/shared/src/schemas/relay-control.ts
    - packages/shared/src/index.ts
    - packages/shared/src/schemas/__tests__/envelope.test.ts
    - packages/shared/src/schemas/__tests__/relay-control.test.ts

key-decisions:
  - "terminal_frame and pty_state envelopes use 3-value source enum (proxy/client/relay) instead of global BaseEnvelopeFields 2-value enum, to support relay-originated messages without breaking existing types"

patterns-established:
  - "Phase 6 envelope types inline their field definitions instead of spreading BaseEnvelopeFields when source enum differs"

requirements-completed: [FEISHU-01, FEISHU-03, FEISHU-04]

duration: 4min
completed: 2026-04-08
---

# Phase 6 Plan 01: Shared Protocol Schema Extensions Summary

**Zod schemas for terminal grid frames, PTY semantic state, relay-control directory/command/file-tree/history messages, and proxy naming**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-08T11:52:23Z
- **Completed:** 2026-04-08T11:56:40Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Added TermSpanSchema, TerminalFramePayloadSchema, and PtyStatePayloadSchema with full type exports
- Extended MessageEnvelopeSchema from 16 to 18 types (terminal_frame, pty_state)
- Added 7 new relay-control message types: dir_list_request/response, command_list_push, file_tree_push, session_history_request/response
- Extended proxy_register and proxy_list_response with optional name field
- Extended SessionCreatePayload with optional cwd and SessionListPayload with optional mode

## Task Commits

Each task was committed atomically (TDD: test then feat):

1. **Task 1: Extend session.ts with TerminalFramePayload, PtyStatePayload, and SessionCreate cwd**
   - `d77b39a` (test: failing tests)
   - `0cc7754` (feat: implementation)
2. **Task 2: Extend envelope.ts and relay-control.ts with Phase 6 types**
   - `814f86f` (test: failing tests)
   - `5c234fc` (feat: implementation)

_TDD tasks each have two commits (test then feat)_

## Files Created/Modified
- `packages/shared/src/schemas/session.ts` - TermSpanSchema, TerminalFramePayloadSchema, PtyStatePayloadSchema, cwd on SessionCreate, mode on SessionList
- `packages/shared/src/schemas/envelope.ts` - terminal_frame and pty_state envelope entries with 3-value source enum
- `packages/shared/src/schemas/relay-control.ts` - 7 new control message types, proxy_register name, proxy_list_response name
- `packages/shared/src/index.ts` - Export new schemas and types
- `packages/shared/src/schemas/__tests__/envelope.test.ts` - 12 new tests for frame/state/cwd/mode schemas and envelopes
- `packages/shared/src/schemas/__tests__/relay-control.test.ts` - 9 new tests for Phase 6 relay-control messages

## Decisions Made
- terminal_frame and pty_state envelope types use inline field definitions with `source: z.enum(["proxy", "client", "relay"])` instead of spreading BaseEnvelopeFields which only allows `["proxy", "client"]`. This avoids breaking existing type contracts while allowing relay-originated messages for these specific types.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- vitest v4 uses `--bail` instead of `-x` flag; adjusted command accordingly
- Worktree needed `pnpm install` before tests could run (expected for fresh worktree)

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All Phase 6 downstream plans can now import the new schema types
- 136 tests passing across shared package, build successful
- Ready for Plan 02 (proxy PTY grid extraction) and Plan 03 (relay routing)

## Self-Check: PASSED

All 6 files verified present. All 4 commit hashes verified in git log.

---
*Phase: 06-feishu-mini-program-core-interaction*
*Completed: 2026-04-08*
