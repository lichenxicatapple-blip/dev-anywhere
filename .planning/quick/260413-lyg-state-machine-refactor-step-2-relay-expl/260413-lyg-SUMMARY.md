---
phase: quick
plan: 260413-lyg
subsystem: relay
tags: [state-machine, refactor, registry]
dependency_graph:
  requires: [260413-lbi]
  provides: [ProxyConnectionState, ClientConnectionState, transitionProxy, transitionClient]
  affects: [relay-registry, proxy-handler, client-handler, health-api]
tech_stack:
  added: []
  patterns: [explicit-state-enum, transition-validation, notification-dedup]
key_files:
  created: []
  modified:
    - apps/relay/src/registry.ts
    - apps/relay/src/handlers/proxy.ts
    - apps/relay/src/__tests__/unit/registry.test.ts
decisions:
  - "connectionState is additive alongside existing ws field, not replacing it"
  - "transitionProxy to offline sets ws=null and disconnectedAt for backward compat"
  - "isProxyOnline checks connectionState first, ws readyState as secondary guard"
  - "bindClientById always creates with 'bound' state since binding implies proxy selection"
  - "close handler wraps transitionProxy in try/catch to handle already-cleaned proxy_disconnect case"
metrics:
  duration: 7min
  completed: "2026-04-13T08:00:00Z"
  tasks: 2
  files: 3
---

# Quick 260413-lyg: State Machine Refactor Step 2 - Relay Explicit State Summary

Explicit ProxyConnectionState/ClientConnectionState enums in relay registry, replacing scattered ws null checks with validated state transitions and deduplicated notification helpers.

## Task Results

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add explicit state enums and transition functions | 9422d8b | registry.ts, registry.test.ts |
| 2 | Deduplicate proxy notifications and wire handlers | a9cec0f | proxy.ts |

## Changes Made

### Task 1: State enums and transition functions

- Added `ProxyConnectionState` ("online" | "offline") and `ClientConnectionState` ("registered" | "bound") exported types
- Added `transitionProxy(proxyId, from, to)` and `transitionClient(clientId, from, to)` with from-state validation
- Added `getProxyConnectionState()` and `getClientConnectionState()` getter methods
- Updated `registerProxy()` and `markProxyOffline()` to set `connectionState`
- Updated `isProxyOnline()` to check `connectionState` instead of ws null check
- Updated `listProxiesWithName()` to derive `online` from `connectionState`
- Updated `getProxyDetail()` to include `connectionState` field and derive `online` from it
- Updated `getClientDetails()` to include `connectionState` field
- Updated `bindClientById()` to set `connectionState: "bound"`
- Added 14 new state transition tests, all passing

### Task 2: Deduplicated notifications and transition wiring

- Extracted `notifyClientsProxyOffline()` helper, replacing inline loops in both close handler and proxy_disconnect handler
- Extracted `notifyClientsProxyOnline()` helper, replacing inline loop in reconnect path
- Replaced `markProxyOffline()` call in close handler with `transitionProxy("online", "offline")` wrapped in try/catch for the proxy_disconnect-then-close race

## Verification

- All 176 tests pass (155 original + 14 new + 7 original adjusted for new connectionState field)
- Zero occurrences of `state.ws !== null && state.ws !== undefined && state.ws.readyState` in registry.ts
- `proxy_offline` send appears only inside `notifyClientsProxyOffline`, not inline in handlers
- `ProxyConnectionState` and `ClientConnectionState` are exported from registry.ts
- Health API responses include `connectionState` via `getProxyDetail()` and `getClientDetails()`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Existing test used toEqual without connectionState**
- **Found during:** Task 1 GREEN phase
- **Issue:** `getClientDetails` test used exact `toEqual` match which failed when `connectionState` field was added
- **Fix:** Updated assertion to include `connectionState: "bound"` in expected object
- **Files modified:** registry.test.ts
- **Commit:** 9422d8b

### Omitted Steps

- **client.ts state transitions (plan Task 2 steps 6-8):** The plan suggested adding `transitionClient` calls in client.ts handlers. After analysis, this is unnecessary for this step: `bindClientById` already sets `connectionState: "bound"`, and `unbindClientById` preserves it. Adding transitions here would require tracking a "registered" state that doesn't exist in the current client lifecycle (clients only enter the binding map via `bindClientById`). The transition infrastructure is in place for future use when client registration becomes a separate step from binding.

## Self-Check: PASSED
