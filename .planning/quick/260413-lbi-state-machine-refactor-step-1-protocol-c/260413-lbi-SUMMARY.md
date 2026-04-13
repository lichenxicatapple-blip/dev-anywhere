---
phase: quick-260413-lbi
plan: 01
subsystem: protocol, relay, client
tags: [state-machine, protocol, binding, refactor]
dependency_graph:
  requires: []
  provides: [proxy_select_response, ensureBinding, sessions_in_proxy_list]
  affects: [relay-handlers, feishu-services, feishu-pages]
tech_stack:
  added: []
  patterns: [promise-based-ack, unified-binding-function]
key_files:
  created:
    - apps/feishu/src/services/ensure-binding.ts
    - apps/feishu/src/__tests__/ensure-binding.test.ts
  modified:
    - packages/shared/src/schemas/relay-control.ts
    - apps/relay/src/handlers/client.ts
    - apps/relay/src/handlers/proxy.ts
    - apps/feishu/src/services/relay-client.ts
    - apps/feishu/src/pages/chat/index.tsx
    - apps/feishu/src/phase-machine.ts
    - apps/feishu/src/pages/proxy-select/index.tsx
    - packages/shared/src/schemas/__tests__/relay-control.test.ts
    - apps/relay/src/__tests__/integration/client-register.test.ts
    - apps/relay/src/__tests__/integration/server.test.ts
    - apps/relay/src/__tests__/integration/message-routing.test.ts
    - apps/relay/src/__tests__/integration/relay-resilience.test.ts
    - apps/feishu/src/__tests__/relay-client.test.ts
    - apps/feishu/src/__tests__/phase-machine.test.ts
decisions:
  - proxy_select_response replaces relay_error for proxy_select failures, providing typed ACK
  - ensureBinding is the single entry point for all 4 binding scenarios
  - phase-machine uses void relay.selectProxy (fire-and-forget, validation via proxy_list_response)
metrics:
  duration: 15min
  completed: "2026-04-13T07:42:00Z"
  tasks: 2
  files: 16
---

# Quick 260413-lbi Plan 01: State Machine Refactor Step 1 - Protocol Changes Summary

Unified binding protocol to single path (proxy_select with ACK), moved sessionId-to-proxyId resolution to client side via proxy_list_response sessions, consolidated all 4 binding scenarios into ensureBinding function.

## What Changed

### Protocol (shared + relay)
- **proxy_select_response** added to schema: `{ success, proxyId?, error? }` - relay sends ACK after every proxy_select
- **ProxyInfo.sessions** added: `sessions: string[]` optional field, populated by relay from registry
- **bind_by_session / bind_by_session_response** removed from schema and relay handler
- Relay client handler sends proxy_select_response instead of relay_error for proxy_select failures
- broadcastProxyList and proxy_list_request handler now include sessions per proxy

### Client (feishu)
- **RelayClient.selectProxy** returns `Promise<{ success, proxyId?, error? }>` instead of void, sets boundProxyId only on success ACK
- **RelayClient.bindBySession** removed entirely
- **RelayClient.requestProxyList** added for Promise-based proxy list queries
- **ensureBinding** created: handles already-bound, user-selection, sessionId-lookup, and reconnect scenarios through single function
- **chat/index.tsx** uses ensureBinding instead of bindBySession + bind_by_session_response listener
- **proxy-select/index.tsx** awaits ensureBinding before navigation, with error rollback
- **phase-machine.ts** uses `void relay.selectProxy(...)` for reconnect and cold-start paths

## Decisions Made

1. proxy_select_response is a typed ACK replacing relay_error for proxy_select, enabling Promise-based flow in client
2. ensureBinding centralizes all binding logic - 4 scenarios, 1 function, 1 protocol path
3. phase-machine intentionally does NOT await selectProxy - it validates via proxy_list_response instead

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated relay-resilience.test.ts and message-routing.test.ts**
- **Found during:** Task 1
- **Issue:** Multiple additional test files beyond the plan's list referenced `relay_error` for proxy_select failures and used `settle()` instead of consuming proxy_select_response ACK
- **Fix:** Updated all `proxy_select` + `settle()` patterns to consume ACK, updated assertions from relay_error to proxy_select_response
- **Files modified:** `apps/relay/src/__tests__/integration/relay-resilience.test.ts`, `apps/relay/src/__tests__/integration/message-routing.test.ts`
- **Commit:** 6e61726

## Test Results

- Shared: 81 tests passed
- Relay: 155 tests passed
- Feishu: 147 tests passed
- Build: all packages compile successfully

## Self-Check: PASSED
