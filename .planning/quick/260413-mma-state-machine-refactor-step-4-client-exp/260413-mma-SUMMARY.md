---
phase: quick-260413-mma
plan: 01
subsystem: feishu-client
tags: [state-machine, refactor, phase-cleanup]
dependency_graph:
  requires: [quick-260413-lbi]
  provides: [clean-client-state-machine, registering-phase, ensureBinding-cold-start]
  affects: [apps/feishu]
tech_stack:
  patterns: [explicit-state-machine, ensureBinding-unified-binding]
key_files:
  created: []
  modified:
    - apps/feishu/src/stores/app-store.ts
    - apps/feishu/src/phase-machine.ts
    - apps/feishu/src/pages/proxy-select/index.tsx
    - apps/feishu/src/pages/session-list/index.tsx
    - apps/feishu/src/app.tsx
    - apps/feishu/src/__tests__/phase-machine.test.ts
    - apps/feishu/src/__tests__/app-store.test.ts
  deleted:
    - apps/feishu/src/pages/proxy-select/cold-start.ts
    - apps/feishu/src/__tests__/cold-start.test.ts
decisions:
  - proxy_lost phase removed entirely; proxy offline only sets proxyOnline flag + toast
  - registering phase added as intermediate between ws connect and register_response
  - cold-start logic inlined into phase-machine using ensureBinding instead of separate module
  - pages no longer correct phase via useDidShow; phase is state-machine-driven only
  - cc_proxyId Storage write moved to after ensureBinding ACK success
metrics:
  duration: 5min
  completed: 2026-04-13T08:27:34Z
  tasks: 2
  files: 9
---

# Quick Task 260413-mma: Client State Machine Refactor Step 4 Summary

Client state machine cleanup: removed proxy_lost phase, added registering phase, replaced cold-start.ts with ensureBinding-based flow inlined in phase-machine.ts, eliminated useDidShow phase correction hacks from pages.

## What Changed

### AppPhase Type (app-store.ts)
- Removed `proxy_lost` from the union type
- Added `registering` to the union type
- `phaseBeforeDisconnect` now only recorded on `reconnecting` transition (not proxy_lost)
- `cleanStorageForPhaseTransition` no longer checks proxy_lost

### State Machine (phase-machine.ts)
- **Complete rewrite** of both `handleWsStatusChange` and `handleRelayMessage`
- `handleRelayMessage` is now `async` (for ensureBinding)
- New `client_register_response` handler: registering -> proxy_selecting
- `proxy_offline`: only `SET_PROXY_ONLINE false` + toast, no phase change, no timer, no reLaunch
- `proxy_online`: only `SET_PROXY_ONLINE true` + toast, no timer cancellation needed
- Cold start: uses `ensureBinding` directly instead of `resolveColdStart`
- `PhaseRelay` interface extended with `requestProxyList()` and `getBoundProxyId()`
- `Timers` interface simplified: removed `proxyLost` field

### Pages
- **proxy-select/index.tsx**: removed `useDidShow` phase correction; moved `cc_proxyId` Storage write to after ensureBinding success
- **session-list/index.tsx**: removed `useDidShow` phase correction

### Deleted
- `cold-start.ts`: logic inlined into phase-machine.ts proxy_list_response handler
- `cold-start.test.ts`: no longer needed

### Tests
- **phase-machine.test.ts**: complete rewrite covering registering transition, proxy offline/online without proxy_lost, cold start via ensureBinding (including failure case), reconnect validation
- **app-store.test.ts**: removed proxy_lost tests, added registering phase test

## Deviations from Plan

None - plan executed exactly as written. Tasks 1 and 2 were committed together because the pre-commit hook runs typecheck + lint + tests on the full codebase, requiring both source and test changes to be consistent.

## Verification Results

1. `npx tsc --noEmit -p apps/feishu/tsconfig.json` - PASSED
2. `pnpm --filter feishu run test` - 144 tests passed (13 files)
3. Zero occurrences of "proxy_lost" in apps/feishu/src/ - CONFIRMED
4. Zero occurrences of "resolveColdStart" in apps/feishu/src/ - CONFIRMED
5. Zero occurrences of "useDidShow.*SET_PHASE" in pages/ - CONFIRMED

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1+2 | 6111414 | Rewrite client state machine + tests |

## Self-Check: PASSED
- All key files verified present
- Deleted files verified absent
- Commit 6111414 verified in git log
- All 144 tests passing
