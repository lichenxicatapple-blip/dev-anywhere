---
phase: 08-business-logic-adaptation
plan: 02
subsystem: services
tags: [websocket, binary-frames, state-machine, zustand, react-router]

requires:
  - phase: 08-01
    provides: zustand stores (app-store, toast-store), router.tsx, path aliases
provides:
  - WebSocketManager with text+binary dispatch and exponential backoff
  - RelayClient protocol client (verbatim from feishu)
  - ensureBinding/isBindingError binding logic (verbatim from feishu)
  - phase-machine with dissolved PhaseNav, direct zustand+router access
affects: [08-03]

tech-stack:
  added: []
  patterns: [direct-zustand-access, native-websocket-binary, exponential-backoff]

key-files:
  created:
    - apps/web/src/services/websocket.ts
    - apps/web/src/services/relay-client.ts
    - apps/web/src/services/ensure-binding.ts
    - apps/web/src/services/phase-machine.ts
  modified: []

key-decisions:
  - "WebSocket manager uses native WebSocket with arraybuffer binaryType, no Taro abstraction"
  - "Phase-machine accesses useAppStore.getState() directly instead of injected getState/dispatch"
  - "Route mapping: /pages/proxy-select/index -> /, /pages/session-list/index -> /sessions, /pages/chat/index?sessionId=X&mode=M -> /chat/X?mode=M"

patterns-established:
  - "Direct store access: useAppStore.getState().methodName() from non-React code"
  - "subscribeBinary(sessionId, handler) for per-session binary data delivery"

requirements-completed: [FRONT-09, FRONT-10]

duration: 4min
completed: 2026-04-16
---

# Phase 08 Plan 02: Service Layer Summary

**Unified WebSocket manager with text+binary dispatch and exponential backoff, plus phase-machine with dissolved PhaseNav using direct zustand/router access**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-16T07:08:21Z
- **Completed:** 2026-04-16T07:12:51Z
- **Tasks:** 2
- **Files created:** 4

## Accomplishments
- WebSocket manager rewritten from scratch: native WebSocket, arraybuffer binary mode, exponential backoff (1s to 30s cap), subscribeBinary for per-session PTY data
- relay-client.ts and ensure-binding.ts copied verbatim from feishu with no modifications needed
- Phase-machine adapted: PhaseNav/PhaseRelay/Dispatch interfaces removed, all state access via useAppStore.getState(), navigation via router.navigate(), storage via localStorage, toast via useToastStore

## Task Commits

Each task was committed atomically:

1. **Task 1: Create WebSocket manager and copy service files** - `e61cdbd` (feat)
2. **Task 2: Create phase-machine with dissolved PhaseNav** - `affaf04` (feat)

## Files Created/Modified
- `apps/web/src/services/websocket.ts` - Unified WebSocket manager with text+binary dispatch, exponential backoff reconnect
- `apps/web/src/services/relay-client.ts` - Relay protocol client (verbatim copy from feishu)
- `apps/web/src/services/ensure-binding.ts` - Proxy binding logic (verbatim copy from feishu)
- `apps/web/src/services/phase-machine.ts` - State machine with dissolved PhaseNav, direct zustand+router access

## Decisions Made
- WebSocket manager uses native WebSocket API directly instead of any Taro abstraction layer
- Phase-machine calls useAppStore.getState() directly rather than receiving getState/dispatch as parameters, eliminating the need for PhaseNav/PhaseRelay adapter interfaces
- Route mapping adapted from Taro paths to react-router hash routes: `/pages/chat/index?sessionId=X&mode=M` becomes `/chat/X?mode=M`

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- shared package dist not pre-built in worktree, causing typecheck to fail on @cc-anywhere/shared imports. Resolved by running `pnpm --filter shared build` before typecheck.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All 4 service files type-check and are ready for Plan 03 to wire into app.tsx
- WebSocketManager, RelayClient, ensureBinding, handleWsStatusChange, handleRelayMessage all exported and ready for consumption

---
*Phase: 08-business-logic-adaptation*
*Completed: 2026-04-16*
