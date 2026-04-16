---
phase: 08-business-logic-adaptation
plan: 03
subsystem: ui
tags: [react-hooks, websocket, relay-client, phase-machine, app-wiring]

requires:
  - phase: 08-01
    provides: zustand stores (app-store, toast-store), router.tsx, toast component
  - phase: 08-02
    provides: WebSocketManager, RelayClient, ensureBinding, phase-machine
provides:
  - useRelaySetup hook wiring WebSocket + RelayClient + phase-machine lifecycle
  - Rewritten app.tsx with RouterProvider + flat structure
  - pty-test using unified WebSocketManager via subscribeBinary
  - Module-level wsManagerRef/relayClientRef singletons for page access
affects: [09-persistence, 10-features, 11-replay]

tech-stack:
  added: []
  patterns: [module-level-singleton-ref, visibility-reconnect, subscribe-unsubscribe-binary]

key-files:
  created:
    - apps/web/src/hooks/use-relay-setup.ts
    - apps/web/src/vite-env.d.ts
  modified:
    - apps/web/src/app.tsx
    - apps/web/src/pages/pty-test.tsx

key-decisions:
  - "Module-level wsManagerRef/relayClientRef exported from use-relay-setup for non-hook page access"
  - "vite-env.d.ts added for import.meta.env type support"

patterns-established:
  - "useRelaySetup() called once in App, creates WS+Relay+PhaseMachine lifecycle"
  - "Pages access shared WebSocket via wsManagerRef import, not prop drilling or context"
  - "subscribeBinary(sessionId, handler) pattern for per-session PTY data consumption"

requirements-completed: [FRONT-09, FRONT-10]

duration: 3min
completed: 2026-04-16
---

# Phase 08 Plan 03: App Wiring Summary

**useRelaySetup hook wiring WebSocket + RelayClient + phase-machine chain, flat app.tsx with RouterProvider, and pty-test unified to subscribeBinary**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-16T07:15:45Z
- **Completed:** 2026-04-16T07:18:42Z
- **Tasks:** 2 of 3 (Task 3 is human-verify checkpoint, pending)
- **Files modified:** 4

## Accomplishments
- useRelaySetup hook creates WebSocketManager + RelayClient + phase-machine wiring in a single useEffect
- D-18 relay URL priority chain: localStorage > VITE_RELAY_URL > window.location.origin
- visibilitychange listener triggers reconnect when page returns from background (D-08)
- app.tsx rewritten from manual hashchange router to flat RouterProvider + Toast structure
- pty-test page stripped of 142 lines of direct WebSocket code, replaced with subscribeBinary pattern
- Module-level singleton refs (wsManagerRef, relayClientRef) for page-level access without prop drilling

## Task Commits

Each task was committed atomically:

1. **Task 1: Create useRelaySetup hook and rewrite app.tsx** - `4aedf13` (feat)
2. **Task 2: Modify pty-test to use unified WebSocket manager** - `b498e2e` (feat)
3. **Task 3: Verify full business logic chain end-to-end** - PENDING (checkpoint:human-verify)

## Files Created/Modified
- `apps/web/src/hooks/use-relay-setup.ts` - Initialization hook: WebSocket + RelayClient + phase-machine wiring with visibilitychange reconnect
- `apps/web/src/vite-env.d.ts` - Vite client type declarations for import.meta.env
- `apps/web/src/app.tsx` - Rewritten: RouterProvider + useRelaySetup + Toast, no manual hash routing
- `apps/web/src/pages/pty-test.tsx` - Unified to subscribeBinary, removed direct WebSocket code

## Decisions Made
- Module-level `wsManagerRef` and `relayClientRef` exported as mutable singleton refs from use-relay-setup. Single-user app context makes this safe; avoids React Context overhead.
- Added `vite-env.d.ts` for `import.meta.env.VITE_RELAY_URL` type resolution. Standard Vite practice, was missing from the web app.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added vite-env.d.ts for import.meta.env types**
- **Found during:** Task 1 (useRelaySetup hook creation)
- **Issue:** `import.meta.env.VITE_RELAY_URL` caused TS2339 because Vite client types were not declared
- **Fix:** Created `apps/web/src/vite-env.d.ts` with `/// <reference types="vite/client" />`
- **Files modified:** apps/web/src/vite-env.d.ts
- **Verification:** `pnpm --filter web typecheck` passes
- **Committed in:** 4aedf13

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Standard Vite setup file, necessary for typecheck. No scope creep.

## Issues Encountered
None beyond the vite-env.d.ts addition documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Full app lifecycle wired: open app -> WebSocket connects -> registers -> phase transitions -> route navigation
- pty-test ready for binary PTY data via unified WebSocket
- Task 3 checkpoint pending: human verification of full end-to-end chain
- All D-01 through D-22 decisions from Phase 8 context implemented across Plans 01-03

---
*Phase: 08-business-logic-adaptation*
*Completed: 2026-04-16*
