---
phase: 08-business-logic-adaptation
verified: 2026-04-16T08:19:11Z
status: human_needed
score: 17/18 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Start relay + proxy + web dev server, open browser at http://localhost:5173/"
    expected: "ProxySelect page shows phase transitioning connecting -> registering -> proxy_selecting, WebSocket connected=true, proxy list populated"
    why_human: "Full end-to-end lifecycle requires running relay and proxy servers, cannot verify programmatically without live infrastructure"
  - test: "Navigate to /#/pty-test, enter sessionId, click Subscribe"
    expected: "PTY data renders in xterm.js terminal via unified WebSocket (no separate connection), binary frames flow through subscribeBinary"
    why_human: "Live binary data flow verification requires active PTY session and relay server"
  - test: "Kill relay server, wait 10s, restart it"
    expected: "App reconnects via exponential backoff, phase transitions through reconnecting back to correct state"
    why_human: "Reconnection behavior requires live network disruption testing"
---

# Phase 8: Business Logic Adaptation Verification Report

**Phase Goal:** All non-UI business logic (state machine, stores, services, WebSocket layer) works with browser-native APIs instead of Taro
**Verified:** 2026-04-16T08:19:11Z
**Status:** human_needed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

**Roadmap Success Criteria:**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC-1 | phase-machine navigates between routes using react-router (hash mode), with localStorage replacing Taro storage | VERIFIED | `phase-machine.ts` imports `router` from `@/lib/router`, calls `router.navigate('/')`, `router.navigate('/sessions')`, `router.navigate('/chat/...')`. Uses `localStorage.getItem/removeItem` for cc_proxyId, cc_sessionId, cc_sessionMode. Zero Taro references. |
| SC-2 | relay-store establishes WebSocket connection using native browser WebSocket (no Taro codepath), including binary frame reception | VERIFIED | `websocket.ts` uses `new WebSocket(url)` with `binaryType = 'arraybuffer'`. `dispatchBinary()` parses binary frames and routes via `subscribeBinary()`. No Taro, TaskLike, or IS_H5 references anywhere in `apps/web/src/services/`. |
| SC-3 | All migrated stores and services pass type checking | VERIFIED | `pnpm --filter web typecheck` exits 0. `pnpm --filter web build` succeeds producing dist/ output. |

**Plan 01 Truths:**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| P01-1 | zustand stores export hooks accessible in and outside React components | VERIFIED | All 6 stores export hooks (useAppStore, useSessionStore, useChatStore, useCommandStore, useFileStore, useToastStore). phase-machine.ts uses `useAppStore.getState()` outside React context. Pages use hooks inside React. |
| P01-2 | app-store reads/writes clientId from localStorage on initialization | VERIFIED | `loadClientId()` calls `localStorage.getItem('cc_clientId')`, generates and saves via `localStorage.setItem('cc_clientId', id)` if absent. Called during store creation. |
| P01-3 | app-store transitionToPhase cleans localStorage per D-03 rules | VERIFIED | `cleanStorageForPhaseTransition` removes cc_proxyId+cc_sessionId when next='proxy_selecting', removes cc_sessionId when transitioning from 'chatting' to 'session_browsing'. |
| P01-4 | createHashRouter with all 5 route paths defined | VERIFIED | `router.tsx` creates `createHashRouter` with paths: `/`, `/sessions`, `/chat/:id`, `/pty-test`, `/tokens`. |
| P01-5 | toast-store showToast auto-removes after 3 seconds | VERIFIED | `showToast` appends toast then calls `setTimeout(() => { ... filter ... }, 3000)`. |

**Plan 02 Truths:**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| P02-1 | WebSocketManager handles both text and binary messages on single connection | VERIFIED | `ws.addEventListener('message', ...)` checks `event.data instanceof ArrayBuffer` for binary dispatch, else treats as string for text handlers. Single `new WebSocket(url)` connection. |
| P02-2 | WebSocketManager reconnects with exponential backoff: 1s, 2s, 4s, 8s, capped at 30s | VERIFIED | `scheduleReconnect()` computes `Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000)`, increments attempt counter. |
| P02-3 | subscribeBinary delivers only PTY data for subscribed sessionId | VERIFIED | `dispatchBinary()` parses sessionId from binary frame header, looks up `binarySubscribers.get(sessionId)` Set, only calls handlers for that session. |
| P02-4 | phase-machine uses useAppStore.getState()/setState() directly | VERIFIED | 15+ calls to `useAppStore.getState()` in phase-machine.ts. No dispatch/getState parameters. No PhaseNav/Dispatch interfaces. |
| P02-5 | phase-machine navigates via router.navigate() | VERIFIED | `router.navigate('/')`, `router.navigate('/sessions')`, `router.navigate('/chat/...')` found. No reLaunch or navigateTo. |
| P02-6 | phase-machine uses localStorage directly | VERIFIED | `localStorage.getItem('cc_proxyId')`, `localStorage.getItem('cc_sessionId')`, `localStorage.getItem('cc_sessionMode')`, `localStorage.removeItem(...)`. No getStorageSync/removeStorageSync. |
| P02-7 | relay-client.ts and ensure-binding.ts are direct copies from feishu | VERIFIED | Byte-identical comparison: both files match feishu versions exactly. Same imports resolve via identical `@/services/websocket` and `./relay-client` paths. |

**Plan 03 Truths:**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| P03-1 | app.tsx renders RouterProvider with hash router, no manual hashchange | VERIFIED | `app.tsx` contains `<RouterProvider router={router} />`. No `hashchange`, no `useState` for routing. |
| P03-2 | useRelaySetup creates WS+RelayClient, wires status/message handlers, connects | VERIFIED | Hook creates `new WebSocketManager()`, `new RelayClient(ws, clientId)`, wires `ws.onStatusChange(handleWsStatusChange)`, `relay.onMessage(handleRelayMessage)`, calls `ws.connect(relayUrl)`. |
| P03-3 | visibilitychange listener triggers reconnect on page resume | VERIFIED | `document.addEventListener('visibilitychange', handleVisibility)` with guard `document.visibilityState === 'visible' && !wsRef.current.isConnected()`. |
| P03-4 | pty-test uses unified WebSocketManager.subscribeBinary() | VERIFIED | `pty-test.tsx` imports `wsManagerRef` from use-relay-setup, calls `wsManagerRef.subscribeBinary(sessionId, handler)`. No `new WebSocket(`, no `ws.binaryType`, no `ws.onopen`. |
| P03-5 | relay URL resolved with D-18 priority: localStorage > VITE_RELAY_URL > origin | VERIFIED | `use-relay-setup.ts` line 23-25: `stored = localStorage.getItem('cc_relayUrl')`, `envUrl = import.meta.env.VITE_RELAY_URL`, `relayUrl = stored || envUrl || window.location.origin`. |
| P03-6 | Full app lifecycle works: open -> WS connects -> registers -> proxy_selecting -> route to / | NEEDS HUMAN | Cannot verify without running relay + proxy infrastructure. All code paths exist and are wired, but runtime behavior requires live testing. |

**Score:** 17/18 truths verified (1 requires human verification)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/web/src/stores/app-store.ts` | App state zustand store | VERIFIED | 88 lines, exports useAppStore + AppPhase, devtools middleware, localStorage integration |
| `apps/web/src/stores/session-store.ts` | Session list zustand store | VERIFIED | 60 lines, exports useSessionStore, 7 action methods |
| `apps/web/src/stores/chat-store.ts` | Chat messages zustand store | VERIFIED | 181 lines, exports useChatStore + 4 interfaces, 14 action methods |
| `apps/web/src/stores/command-store.ts` | Command cache zustand store | VERIFIED | 23 lines, exports useCommandStore, setCommands with timestamp |
| `apps/web/src/stores/file-store.ts` | File tree cache zustand store | VERIFIED | 27 lines, exports useFileStore, Map-based tree with immutable updates |
| `apps/web/src/stores/toast-store.ts` | Toast notification store | VERIFIED | 37 lines, exports useToastStore, setTimeout auto-remove |
| `apps/web/src/lib/router.tsx` | Hash router instance | VERIFIED | 14 lines, createHashRouter with 5 routes. File is .tsx (not .ts) due to React 19 type compatibility -- documented deviation. |
| `apps/web/src/components/toast.tsx` | Toast UI component | VERIFIED | 20 lines, fixed overlay, driven by useToastStore |
| `apps/web/src/services/websocket.ts` | Unified WebSocket manager | VERIFIED | 148 lines, text+binary dispatch, exponential backoff, subscribeBinary, native WebSocket |
| `apps/web/src/services/relay-client.ts` | Relay protocol client | VERIFIED | 130 lines, verbatim copy from feishu |
| `apps/web/src/services/ensure-binding.ts` | Proxy binding logic | VERIFIED | 56 lines, verbatim copy from feishu |
| `apps/web/src/services/phase-machine.ts` | State machine with dissolved PhaseNav | VERIFIED | 162 lines, direct zustand+router access, no PhaseNav/Dispatch interfaces |
| `apps/web/src/app.tsx` | App entry with RouterProvider | VERIFIED | 14 lines, flat structure: RouterProvider + Toast, no Context nesting |
| `apps/web/src/hooks/use-relay-setup.ts` | Initialization hook | VERIFIED | 75 lines, WS+Relay+PhaseMachine lifecycle, visibilitychange, module-level refs |
| `apps/web/src/pages/pty-test.tsx` | PTY test with unified WebSocket | VERIFIED | 218 lines, uses wsManagerRef.subscribeBinary(), no direct WebSocket code |
| `apps/web/src/pages/proxy-select.tsx` | Debug placeholder page | VERIFIED | 53 lines, shows app-store state, proxy list with select handler |
| `apps/web/src/pages/session-list.tsx` | Debug placeholder page | VERIFIED | 26 lines, shows app+session store state |
| `apps/web/src/pages/chat.tsx` | Debug placeholder page | VERIFIED | 36 lines, shows app+session+chat store state with route params |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| phase-machine.ts | app-store.ts | useAppStore.getState() | WIRED | 15+ calls to useAppStore.getState() throughout both exported functions |
| phase-machine.ts | router.tsx | router.navigate() | WIRED | 5 calls: navigate('/'), navigate('/sessions'), navigate('/chat/...') |
| phase-machine.ts | toast-store.ts | useToastStore.getState().showToast() | WIRED | 2 calls: "Proxy offline" and "Proxy reconnected" |
| relay-client.ts | websocket.ts | constructor injection | WIRED | Constructor receives WebSocketManager, calls ws.send() and ws.onMessage() |
| websocket.ts | native WebSocket | new WebSocket() | WIRED | doConnect() creates new WebSocket(this.url) with arraybuffer binaryType |
| app.tsx | use-relay-setup.ts | useRelaySetup() call | WIRED | App component calls useRelaySetup() on line 7 |
| app.tsx | router.tsx | RouterProvider router prop | WIRED | `<RouterProvider router={router} />` on line 10 |
| use-relay-setup.ts | websocket.ts | new WebSocketManager() | WIRED | Creates instance, stores in wsRef and module-level wsManagerRef |
| use-relay-setup.ts | phase-machine.ts | handleWsStatusChange/handleRelayMessage | WIRED | Both wired as callbacks to ws.onStatusChange and relay.onMessage |
| pty-test.tsx | websocket.ts | subscribeBinary() | WIRED | wsManagerRef.subscribeBinary(sessionId, handler) on line 143 |

### Data-Flow Trace (Level 4)

Not applicable for this phase -- all artifacts are services, stores, and debug placeholder pages. No dynamic data rendering that requires upstream trace (stores are populated at runtime by WebSocket events, which requires live infrastructure).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compilation | pnpm --filter web typecheck | Exit code 0, no errors | PASS |
| Production build | pnpm --filter web build | dist/ produced (728KB JS, 27KB CSS) | PASS |
| No Taro references in web services | grep -r "Taro\|TaskLike\|IS_H5" apps/web/src/services/ | No matches | PASS |
| No PhaseNav interface in phase-machine | grep "interface PhaseNav\|type Dispatch" apps/web/src/services/phase-machine.ts | No matches | PASS |
| No direct WebSocket in pty-test | grep "new WebSocket(" apps/web/src/pages/pty-test.tsx | No matches | PASS |
| zustand in dependencies | grep "zustand" apps/web/package.json | "zustand": "^5.0.12" | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| FRONT-09 | 08-01, 08-02, 08-03 | phase-machine 状态机适配（react-router + localStorage） | SATISFIED | phase-machine.ts uses router.navigate() for route transitions, localStorage for state persistence. All Taro navigation patterns replaced with react-router hash mode equivalents. |
| FRONT-10 | 08-01, 08-02, 08-03 | relay-store WebSocket 层清理（移除 Taro 分支，仅保留原生 WebSocket） | SATISFIED | websocket.ts uses native browser WebSocket API exclusively. No Taro, IS_H5, or TaskLike references. Binary frame support via subscribeBinary(). |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | - | - | - | No anti-patterns detected |

No TODO, FIXME, placeholder, or stub patterns found in any Phase 8 files. All action methods are fully implemented. No empty returns or hardcoded empty data (stores initialize with correct defaults that get populated at runtime).

### Human Verification Required

### 1. Full App Lifecycle End-to-End

**Test:** Start relay + proxy + web dev server. Open `http://localhost:5173/`. Observe state transitions in ProxySelect debug page.
**Expected:** Phase transitions: connecting -> registering -> proxy_selecting. WebSocket connected=true. Proxy list populated with available proxies. Selecting a proxy navigates to /sessions.
**Why human:** Requires running relay and proxy infrastructure. State machine lifecycle depends on network messages from live services.

### 2. PTY Binary Data Flow via Unified WebSocket

**Test:** Navigate to `/#/pty-test`, enter a valid sessionId, click Subscribe.
**Expected:** PTY terminal data renders in xterm.js. Binary frames flow through the unified WebSocketManager (no separate WebSocket connection created).
**Why human:** Requires active PTY session producing binary data. Binary frame parsing/routing cannot be verified without live data.

### 3. Reconnection Behavior

**Test:** Kill relay server while app is connected. Wait 10+ seconds. Restart relay.
**Expected:** App shows reconnecting state, exponential backoff timers fire, after relay restart the app recovers to previous state (proxy_selecting or session_browsing depending on prior state).
**Why human:** Reconnection behavior requires live network disruption and timing-sensitive state transitions.

### Gaps Summary

No code-level gaps found. All 17 programmatically verifiable must-haves pass at all verification levels (exists, substantive, wired). Both requirements (FRONT-09, FRONT-10) are satisfied. TypeScript compilation and production build succeed.

The single remaining item (P03-6: full app lifecycle works) requires human verification against live infrastructure. All code paths for this behavior are present, correctly wired, and type-safe -- the verification gap is purely about runtime behavior confirmation.

---

_Verified: 2026-04-16T08:19:11Z_
_Verifier: Claude (gsd-verifier)_
