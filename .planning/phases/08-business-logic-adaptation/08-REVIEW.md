---
phase: 08-business-logic-adaptation
reviewed: 2026-04-16T08:19:59Z
depth: standard
files_reviewed: 22
files_reviewed_list:
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
  - apps/web/src/services/websocket.ts
  - apps/web/src/services/relay-client.ts
  - apps/web/src/services/ensure-binding.ts
  - apps/web/src/services/phase-machine.ts
  - apps/web/src/hooks/use-relay-setup.ts
  - apps/web/src/app.tsx
  - apps/web/src/pages/pty-test.tsx
  - apps/proxy/src/session-manager.ts
  - apps/proxy/src/ipc-protocol.ts
  - apps/proxy/src/terminal.ts
  - apps/proxy/src/serve.ts
findings:
  critical: 0
  warning: 4
  info: 3
  total: 7
status: issues_found
---

# Phase 8: Code Review Report

**Reviewed:** 2026-04-16T08:19:59Z
**Depth:** standard
**Files Reviewed:** 22
**Status:** issues_found

## Summary

Phase 8 migrates business logic from the Feishu mini-program to the web SPA: 6 zustand stores, 4 service files, a React hook for lifecycle management, hash router, and placeholder pages. The proxy-side files (session-manager, ipc-protocol, terminal, serve) were also reviewed for bug fixes.

Overall quality is good. The zustand store migration is clean, the WebSocket manager is a solid rewrite, and the relay-client/ensure-binding files are verbatim copies from the feishu app (verified by diff). Typecheck passes. No security vulnerabilities found.

The main concerns are: (1) missing error handling in the WebSocket manager's `doConnect` that can break the reconnect loop, (2) missing error handling for the `selectProxy` Promise in proxy-select page, (3) Promises without timeout in relay-client that can hang forever, and (4) a stale-state pattern in phase-machine that could cause race conditions under concurrent message handling.

## Warnings

### WR-01: WebSocket doConnect lacks try-catch, reconnect loop can break silently

**File:** `apps/web/src/services/websocket.ts:85`
**Issue:** `new WebSocket(this.url)` in `doConnect()` throws synchronously if the URL is malformed. Since `doConnect` is called from `scheduleReconnect` inside a `setTimeout` callback, an unhandled throw kills the reconnect loop permanently with no recovery and no user feedback. A corrupted `cc_relayUrl` in localStorage could trigger this.
**Fix:**
```typescript
private doConnect(): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(this.url);
  } catch (err) {
    console.warn("WebSocket connection failed:", err);
    if (!this.closed) this.scheduleReconnect();
    return;
  }
  ws.binaryType = "arraybuffer";
  this.ws = ws;
  // ... rest unchanged
}
```

### WR-02: Unhandled Promise rejection in ProxySelectPage.handleSelect

**File:** `apps/web/src/pages/proxy-select.tsx:10`
**Issue:** `relayClientRef.selectProxy(proxyId)` can reject on network failure. Since `handleSelect` is an async function called from `onClick`, the rejection becomes an unhandled promise rejection. The user gets no error feedback.
**Fix:**
```typescript
async function handleSelect(proxyId: string, proxyName: string | undefined) {
  if (!relayClientRef) return;
  try {
    const result = await relayClientRef.selectProxy(proxyId);
    if (result.success) {
      localStorage.setItem("cc_proxyId", proxyId);
      useAppStore.getState().setProxy(proxyId, proxyName || null);
      useAppStore.getState().setProxyOnline(true);
      useAppStore.getState().transitionToPhase("session_browsing");
      router.navigate("/sessions");
    }
  } catch (err) {
    useToastStore.getState().showToast("Failed to select proxy");
    console.warn("Proxy select failed:", err);
  }
}
```

### WR-03: requestProxyList and selectProxy Promises can hang forever

**File:** `apps/web/src/services/relay-client.ts:64-93`
**Issue:** Both `requestProxyList()` and `selectProxy()` create Promises that resolve only when a matching response message arrives. If the WebSocket disconnects before the response arrives, these Promises hang indefinitely. Any caller using `await` (e.g., `ensureBinding` in phase-machine, `handleSelect` in proxy-select) will stall. This is an inherited issue from the feishu version, but now that phase-machine uses fire-and-forget (`void handleRelayMessage(...)`), a stalled `handleRelayMessage` means the function never completes and any subsequent `proxy_list_response` messages trigger a new concurrent execution.
**Fix:** Add timeout to both methods:
```typescript
requestProxyList(): Promise<Array<...>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsub();
      reject(new Error("requestProxyList timeout"));
    }, 10000);
    const unsub = this.onMessage((msg) => {
      if ("type" in msg && (msg as Record<string, unknown>).type === "proxy_list_response") {
        clearTimeout(timeout);
        unsub();
        resolve(/* ... */);
      }
    });
    this.ws.send(JSON.stringify({ type: "proxy_list_request" }));
  });
}
```

### WR-04: Stale state snapshot used across await boundaries in handleRelayMessage

**File:** `apps/web/src/services/phase-machine.ts:60`
**Issue:** `const s = useAppStore.getState()` captures a snapshot on line 60. After `await ensureBinding(...)` on lines 102 and 145, the code continues to reference `s.phase` and `s.selectedProxyId` which may be stale if another message handler ran during the await. Since `handleRelayMessage` is invoked via `void handleRelayMessage(...)` (fire-and-forget from use-relay-setup line 45), multiple calls can interleave. For example, a `proxy_offline` message could change state between the await and the subsequent phase checks. This is inherited from the feishu version but becomes more relevant in the SPA where there is no Taro page lifecycle to serialize state changes.
**Fix:** Re-read state after each await:
```typescript
// After await ensureBinding on line 102:
const result = await ensureBinding(relay, { proxyId: savedProxyId });
const freshState = useAppStore.getState(); // re-read
if (!isBindingError(result)) {
  // use freshState instead of s
```

## Info

### IN-01: console.log in production code (pty-test fixture loader)

**File:** `apps/web/src/pages/pty-test.tsx:24`
**Issue:** `console.log` used for fixture loading diagnostics. This is a test/debug page, so it is acceptable, but it will produce noise in the browser console during normal usage.
**Fix:** Consider gating behind a debug flag or removing the log entirely since the fixture loading is a development feature.

### IN-02: WebSocket URL scheme not validated

**File:** `apps/web/src/hooks/use-relay-setup.ts:25`
**Issue:** The relay URL resolution chain (`localStorage > VITE_RELAY_URL > window.location.origin`) can produce an `http://` or `https://` URL. Modern browsers auto-upgrade these to `ws://`/`wss://` when passed to the WebSocket constructor, but this behavior is not part of the WebSocket spec. If the relay URL is configured as `http://relay.example.com`, it will work in Chrome and Firefox but may fail in non-standard environments.
**Fix:** Add URL scheme normalization:
```typescript
function toWsUrl(url: string): string {
  return url.replace(/^http(s?):\/\//, 'ws$1://');
}
const relayUrl = toWsUrl(stored || envUrl || window.location.origin);
```

### IN-03: Module-level mutable export pattern for wsManagerRef/relayClientRef

**File:** `apps/web/src/hooks/use-relay-setup.ts:13-14`
**Issue:** `export let wsManagerRef` and `export let relayClientRef` are module-level mutable singletons. Any module can import and read them, but they are `null` until `useRelaySetup` runs. Callers must null-check every access. This is documented as a deliberate design choice for a single-user app, so flagging as informational only. If the app ever supports multiple router outlets or concurrent relay connections, this pattern would need rethinking.
**Fix:** No immediate fix needed. Consider a `getWsManager(): WebSocketManager` function that throws if called before initialization, making the failure explicit rather than returning null.

---

_Reviewed: 2026-04-16T08:19:59Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
