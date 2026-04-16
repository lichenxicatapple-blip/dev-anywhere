---
phase: 08-business-logic-adaptation
plan: 01
subsystem: ui
tags: [zustand, react-router, state-management, stores]

requires:
  - phase: 07-design-token-system
    provides: design tokens, app.css variables, shadcn/ui components
provides:
  - 6 zustand stores (app, session, chat, command, file, toast)
  - hash router with 5 routes
  - 3 placeholder debug pages
  - toast UI component
affects: [08-02-services, 08-03-app-wiring]

tech-stack:
  added: [zustand]
  patterns: [zustand devtools middleware, localStorage phase transition cleanup]

key-files:
  created:
    - apps/web/src/stores/app-store.ts
    - apps/web/src/stores/session-store.ts
    - apps/web/src/stores/chat-store.ts
    - apps/web/src/stores/command-store.ts
    - apps/web/src/stores/file-store.ts
    - apps/web/src/stores/toast-store.ts
    - apps/web/src/lib/router.tsx
    - apps/web/src/components/toast.tsx
    - apps/web/src/pages/proxy-select.tsx
    - apps/web/src/pages/session-list.tsx
    - apps/web/src/pages/chat.tsx
  modified:
    - apps/web/package.json
    - pnpm-lock.yaml

key-decisions:
  - "router.tsx instead of router.ts due to React 19 createElement type incompatibility with react-router RouteObject.element"

patterns-established:
  - "zustand store pattern: create<State>()(devtools((set, get) => ({...}), { name }))"
  - "store hooks exported as useXxxStore for both component and service access via getState()"

requirements-completed: [FRONT-09, FRONT-10]

duration: 4min
completed: 2026-04-16
---

# Phase 8 Plan 01: Stores, Router, Toast Summary

**6 zustand stores migrated from feishu Context+useReducer, hash router with 5 routes, 3 debug placeholder pages, and toast notification component**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-16T07:00:34Z
- **Completed:** 2026-04-16T07:04:57Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- All 6 zustand stores created with complete action methods matching feishu reducer logic
- app-store implements localStorage clientId persistence and D-03 phase transition cleanup
- Hash router configured with all 5 routes (/, /sessions, /chat/:id, /pty-test, /tokens)
- 3 placeholder pages display zustand store debug info for end-to-end verification
- Toast store with auto-remove after 3 seconds and Toast overlay component

## Task Commits

Each task was committed atomically:

1. **Task 1: Install zustand and create all 6 stores** - `ffb3aa2` (feat)
2. **Task 2: Create hash router config and toast component** - `bf37546` (feat)

## Files Created/Modified
- `apps/web/src/stores/app-store.ts` - App state with phase machine, localStorage, proxy selection
- `apps/web/src/stores/session-store.ts` - Session list with add/remove/update actions
- `apps/web/src/stores/chat-store.ts` - Chat messages with streaming, tool calls, approvals (14 actions)
- `apps/web/src/stores/command-store.ts` - Slash command cache with timestamp
- `apps/web/src/stores/file-store.ts` - Directory tree cache using Map
- `apps/web/src/stores/toast-store.ts` - Ephemeral toast queue with setTimeout auto-remove
- `apps/web/src/lib/router.tsx` - createHashRouter with 5 route entries
- `apps/web/src/components/toast.tsx` - Fixed-position toast overlay driven by toast-store
- `apps/web/src/pages/proxy-select.tsx` - Debug page showing app-store state
- `apps/web/src/pages/session-list.tsx` - Debug page showing app + session store state
- `apps/web/src/pages/chat.tsx` - Debug page showing app + session + chat store state with route params
- `apps/web/package.json` - Added zustand dependency

## Decisions Made
- Router file uses `.tsx` extension instead of `.ts` because React 19's `createElement` return type is incompatible with react-router v7's `RouteObject.element` (expects `ReactNode`). JSX resolves this cleanly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Router file extension changed from .ts to .tsx**
- **Found during:** Task 2 (Create hash router config)
- **Issue:** `createElement()` return type `FunctionComponentElement` not assignable to `ReactNode` in React 19 + react-router v7 type system
- **Fix:** Used `.tsx` extension with JSX syntax instead of `createElement`
- **Files modified:** apps/web/src/lib/router.tsx (was planned as router.ts)
- **Verification:** `pnpm --filter web typecheck` passes
- **Committed in:** bf37546

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** File extension change only, no functional impact. The `router` export and all route definitions match the plan exactly.

## Issues Encountered
None beyond the router file extension change documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All 6 stores ready for Plan 02 services to call `useXxxStore.getState()` and action methods
- Router instance ready for Plan 02 phase-machine to call `router.navigate()`
- Toast store ready for phase-machine `showToast()` calls
- Placeholder pages ready for Plan 03 app.tsx wiring verification

---
*Phase: 08-business-logic-adaptation*
*Completed: 2026-04-16*
