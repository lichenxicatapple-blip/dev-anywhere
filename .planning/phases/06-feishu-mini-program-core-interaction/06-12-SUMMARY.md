---
phase: 06-feishu-mini-program-core-interaction
plan: 12
subsystem: ui
tags: [websocket, taro, react, feishu, type-safety]

requires:
  - phase: 06-feishu-mini-program-core-interaction
    provides: WebSocketManager, chat-store, message-parser, spike-picker page

provides:
  - Duplicate-safe WebSocket connect() that closes existing socket before reconnecting
  - toolIndex-based UPDATE_TOOL_RESULT preventing data loss with duplicate tool names
  - Type-safe message-parser stream event routing
  - Boolean-returning send() for caller-side drop detection

affects: [06-13-PLAN, relay-client, chat page wiring]

tech-stack:
  added: []
  patterns: [toolIndex matching for tool call results, typeof guards for stream event fields]

key-files:
  created: []
  modified:
    - apps/feishu/src/services/websocket.ts
    - apps/feishu/src/services/message-parser.ts
    - apps/feishu/src/stores/chat-store.ts
    - apps/feishu/src/pages/spike-picker/index.tsx
    - apps/feishu/src/utils/relative-time.ts
    - apps/feishu/src/app.tsx

key-decisions:
  - "UPDATE_TOOL_RESULT matches by array index not toolName to handle duplicate tool names correctly"
  - "send() returns boolean instead of void so callers can detect dropped messages"

patterns-established:
  - "toolIndex matching: tool call results identified by position index, not name"
  - "typeof guards: stream event fields checked with typeof before use, never 'as' cast"

requirements-completed: [FEISHU-01]

duration: 1min
completed: 2026-04-10
---

# Phase 6 Plan 12: Gap Closure Bug Fixes Summary

**Hardened WebSocket duplicate-connection guard, toolIndex-based tool result matching, and type-safe stream event routing**

## Performance

- **Duration:** 1 min
- **Started:** 2026-04-10T12:36:03Z
- **Completed:** 2026-04-10T12:37:25Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- WebSocket.connect() now closes existing socket and clears reconnect timer before creating a new connection, preventing duplicate connections on foreground resume
- UPDATE_TOOL_RESULT matches tool calls by array index instead of toolName, preventing data loss when a message contains multiple tools with the same name (e.g., two Read calls)
- message-parser uses typeof guard instead of unsafe `as string` assertion for stream event text field
- send() returns boolean and logs warning when messages are dropped due to disconnection
- Consolidated duplicate onStatusChange handlers in app.tsx into a single handler
- Fixed relative-time singular forms ("1 min ago" not "1 mins ago")
- Fixed spike-picker compile error (setInsertedPaths -> setInsertedTokens)

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix WebSocket duplicate connections and message-parser type safety** - `e747180` (fix)
2. **Task 2: Fix chat-store UPDATE_TOOL_RESULT matching and spike-picker compile error** - `3ea26b6` (fix)

## Files Created/Modified
- `apps/feishu/src/services/websocket.ts` - Duplicate-safe connect(), boolean-returning send()
- `apps/feishu/src/services/message-parser.ts` - typeof guard for event.text
- `apps/feishu/src/utils/relative-time.ts` - Singular time unit forms
- `apps/feishu/src/app.tsx` - Consolidated onStatusChange handler
- `apps/feishu/src/stores/chat-store.ts` - toolIndex-based UPDATE_TOOL_RESULT
- `apps/feishu/src/pages/spike-picker/index.tsx` - Fixed setInsertedPaths -> setInsertedTokens

## Decisions Made
- UPDATE_TOOL_RESULT uses array index matching because tool names are not unique within a message (multiple Read, Bash, etc.)
- send() returns boolean rather than throwing to keep fire-and-forget callers working without changes

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing TS6059 error (config/index.ts outside rootDir) unrelated to this plan's changes. All modified source files compile cleanly.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- WebSocket and chat-store foundations are now correct for Plan 13 relay message wiring
- toolIndex-based matching ready for dispatching UPDATE_TOOL_RESULT from relay events
- No blockers

---
*Phase: 06-feishu-mini-program-core-interaction*
*Completed: 2026-04-10*
