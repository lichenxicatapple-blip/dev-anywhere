# Phase 8: Business Logic Adaptation - Pattern Map

**Mapped:** 2026-04-16
**Files analyzed:** 21 new/modified files
**Analogs found:** 21 / 21

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/web/src/stores/app-store.ts` | store | CRUD | `apps/feishu/src/stores/app-store.ts` | exact |
| `apps/web/src/stores/session-store.ts` | store | CRUD | `apps/feishu/src/stores/session-store.ts` | exact |
| `apps/web/src/stores/chat-store.ts` | store | CRUD | `apps/feishu/src/stores/chat-store.ts` | exact |
| `apps/web/src/stores/command-store.ts` | store | CRUD | `apps/feishu/src/stores/command-store.ts` | exact |
| `apps/web/src/stores/file-store.ts` | store | CRUD | `apps/feishu/src/stores/file-store.ts` | exact |
| `apps/web/src/stores/toast-store.ts` | store | event-driven | `apps/feishu/src/components/toast/index.tsx` | role-match |
| `apps/web/src/services/websocket.ts` | service | streaming | `apps/feishu/src/services/websocket.ts` | role-match |
| `apps/web/src/services/relay-client.ts` | service | request-response | `apps/feishu/src/services/relay-client.ts` | exact-copy |
| `apps/web/src/services/ensure-binding.ts` | service | request-response | `apps/feishu/src/services/ensure-binding.ts` | exact-copy |
| `apps/web/src/services/phase-machine.ts` | service | event-driven | `apps/feishu/src/phase-machine.ts` | role-match |
| `apps/web/src/lib/router.ts` | config | request-response | `apps/web/src/app.tsx` (current) | partial |
| `apps/web/src/hooks/use-relay-setup.ts` | hook | event-driven | `apps/feishu/src/app.tsx` (useEffect) | role-match |
| `apps/web/src/pages/proxy-select.tsx` | component | request-response | `apps/web/src/pages/pty-test.tsx` | role-match |
| `apps/web/src/pages/session-list.tsx` | component | request-response | `apps/web/src/pages/pty-test.tsx` | role-match |
| `apps/web/src/pages/chat.tsx` | component | request-response | `apps/web/src/pages/pty-test.tsx` | role-match |
| `apps/web/src/components/toast.tsx` | component | event-driven | `apps/feishu/src/components/toast/index.tsx` | exact |
| `apps/web/src/app.tsx` | config | event-driven | `apps/feishu/src/app.tsx` | role-match |
| `apps/web/src/main.tsx` | config | -- | `apps/web/src/main.tsx` (current) | exact |
| `apps/web/src/pages/pty-test.tsx` | component | streaming | `apps/web/src/pages/pty-test.tsx` (current) | exact-modify |
| `apps/web/vite.config.ts` | config | -- | `apps/web/vite.config.ts` (current) | exact-modify |
| `apps/web/tsconfig.app.json` | config | -- | `apps/web/tsconfig.app.json` (current) | exact-modify |

## Pattern Assignments

### `apps/web/src/stores/app-store.ts` (store, CRUD)

**Analog:** `apps/feishu/src/stores/app-store.ts`
**Transformation:** Context + useReducer -> zustand create(). Replace Taro.getStorageSync/setStorageSync -> localStorage. Remove Context/Provider exports. Export single zustand hook.

**Source imports pattern** (lines 1-4):
```typescript
import { createContext, useContext } from "react";
import Taro from "@tarojs/taro";
import type { ProxyInfo } from "@cc-anywhere/shared";
```

**Target imports pattern:**
```typescript
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ProxyInfo } from '@cc-anywhere/shared';
```

**Source state + types** (lines 6-24):
```typescript
export type AppPhase =
  | "connecting"
  | "registering"
  | "reconnecting"
  | "proxy_selecting"
  | "session_browsing"
  | "chatting";

export interface AppState {
  phase: AppPhase;
  phaseBeforeDisconnect: AppPhase | null;
  connected: boolean;
  proxyOnline: boolean;
  selectedProxyId: string | null;
  selectedProxyName: string | null;
  proxies: ProxyInfo[];
  clientId: string;
  relayUrl: string;
}
```

**Source localStorage pattern** (lines 34-40, replace `Taro.getStorageSync/setStorageSync` -> `localStorage.getItem/setItem`):
```typescript
function loadClientId(): string {
  const stored = Taro.getStorageSync("cc_clientId") as string;
  if (stored) return stored;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  Taro.setStorageSync("cc_clientId", id);
  return id;
}
```

**Source phase transition with storage cleanup** (lines 77-94, replace `Taro.removeStorageSync` -> `localStorage.removeItem`):
```typescript
export function cleanStorageForPhaseTransition(prev: AppPhase, next: AppPhase): void {
  if (next === "proxy_selecting") {
    Taro.removeStorageSync("cc_proxyId");
    Taro.removeStorageSync("cc_sessionId");
  }
  if (next === "session_browsing" && prev === "chatting") {
    Taro.removeStorageSync("cc_sessionId");
  }
}
```

**Target zustand structure:** Merge reducer cases into action methods inside `create()`. Use `devtools` middleware with `{ name: 'app-store' }`. Embed `transitionToPhase` as a store action that calls `localStorage.removeItem` internally.

---

### `apps/web/src/stores/session-store.ts` (store, CRUD)

**Analog:** `apps/feishu/src/stores/session-store.ts` (pure reducer, no Taro dependency)

**Source full file** (lines 1-83) -- no Taro dependency, direct conversion:
```typescript
// Key types to preserve
export interface SessionStoreState {
  sessions: SessionInfo[];
  historySessions: HistorySession[];
  currentSessionId: string | null;
  currentSessionMode: "pty" | "json" | null;
}
```

**Source reducer logic** (lines 30-66) -- convert each case to a zustand action method:
```typescript
case "SET_SESSIONS":
  return { ...state, sessions: action.sessions };
case "SET_CURRENT_SESSION":
  return { ...state, currentSessionId: action.sessionId, currentSessionMode: action.mode };
case "REMOVE_SESSION":
  return {
    ...state,
    sessions: state.sessions.filter((s) => s.sessionId !== action.sessionId),
    currentSessionId:
      state.currentSessionId === action.sessionId ? null : state.currentSessionId,
    currentSessionMode:
      state.currentSessionId === action.sessionId ? null : state.currentSessionMode,
  };
```

**Target pattern:** Each `case "ACTION_NAME"` becomes a named method: `setSessions`, `setCurrentSession`, `removeSession`, etc. Use `set()` instead of return spread.

---

### `apps/web/src/stores/chat-store.ts` (store, CRUD)

**Analog:** `apps/feishu/src/stores/chat-store.ts` (pure reducer, no Taro dependency)

**Source types** (lines 4-39) -- preserve all interfaces (`ToolCallInfo`, `ToolApprovalRequest`, `QuotedMessage`, `ChatMessage`, `ChatStoreState`).

**Source APPEND_ASSISTANT_TEXT logic** (lines 67-87) -- most complex reducer case, critical to preserve exactly:
```typescript
case "APPEND_ASSISTANT_TEXT": {
  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg && lastMsg.role === "assistant" && lastMsg.isPartial) {
    return {
      ...state,
      messages: state.messages.map((m, i) =>
        i === state.messages.length - 1 ? { ...m, text: m.text + action.text } : m,
      ),
    };
  }
  const newMsg: ChatMessage = {
    id: `assistant-${Date.now()}`,
    role: "assistant",
    text: action.text,
    isPartial: true,
    timestamp: Date.now(),
    toolCalls: [],
  };
  return { ...state, messages: [...state.messages, newMsg] };
}
```

**Target pattern:** Same as session-store. Each action becomes a method. `MARK_TURN_COMPLETE` clears `isWorking`, `workingToolName`, `pendingApprovals`.

---

### `apps/web/src/stores/command-store.ts` (store, CRUD)

**Analog:** `apps/feishu/src/stores/command-store.ts` (pure reducer, no Taro dependency)

**Source full file** (lines 1-47) -- simplest store, single action:
```typescript
export interface CommandStoreState {
  commands: CommandEntry[];
  lastUpdated: number;
}
// Single action: SET_COMMANDS -> setCommands
```

---

### `apps/web/src/stores/file-store.ts` (store, CRUD)

**Analog:** `apps/feishu/src/stores/file-store.ts` (pure reducer, no Taro dependency)

**Source state uses Map** (lines 7-9):
```typescript
export interface FileStoreState {
  tree: Map<string, DirEntry[]>;
}
```

**Source reducer SET_DIR_ENTRIES** (lines 21-25):
```typescript
case "SET_DIR_ENTRIES": {
  const next = new Map(state.tree);
  next.set(action.path, action.entries);
  return { tree: next };
}
```

**Note:** zustand handles Map fine. Use `set(() => ({ tree: new Map(get().tree).set(path, entries) }))`.

---

### `apps/web/src/stores/toast-store.ts` (store, event-driven)

**Analog:** `apps/feishu/src/components/toast/index.tsx` (lines 8, 10-11, 18-38)

**Source pattern** -- module-level push handler with auto-dismiss timer:
```typescript
let nextId = 0;
// Auto-remove after duration
setTimeout(() => {
  item.remove();
}, duration);
```

**Target pattern:** zustand store with `showToast(message)` action that auto-removes after 3s. Callable from outside React via `useToastStore.getState().showToast()`. See RESEARCH.md Toast Store example.

---

### `apps/web/src/services/websocket.ts` (service, streaming)

**Analog:** `apps/feishu/src/services/websocket.ts`

**Source class structure** (lines 58-211) -- `WebSocketManager` class with connect/send/close/onMessage/onStatusChange API.

**Key changes from source:**
1. Remove `IS_H5` branching and `Taro.connectSocket` path entirely (lines 86-110)
2. Remove `TaskLike` interface (lines 13-20) and `createNativeTask` wrapper (lines 26-56)
3. Use native `WebSocket` directly (like `createNativeTask` but without TaskLike wrapper)
4. Add `ws.binaryType = 'arraybuffer'` immediately after construction
5. Add binary frame dispatch: parse 1B length + sessionId + ptyData (from Phase 9 D-43)
6. Add `subscribeBinary(sessionId, handler)` API returning unsubscribe function
7. Replace fixed 2s reconnect (line 9) with exponential backoff: `Math.min(1000 * 2^attempt, 30000)`

**Source API surface to preserve** (lines 163-210):
```typescript
send(data: string): boolean
close(): void
onMessage(handler: (data: string) => void): () => void
onStatusChange(handler: (connected: boolean) => void): () => void
isConnected(): boolean
```

**Source pending queue pattern** (lines 163-188):
```typescript
send(data: string): boolean {
  if (!this.task) {
    console.warn("WebSocket send dropped: no socket");
    return false;
  }
  if (!this.connected) {
    this.pendingQueue.push(data);
    return false;
  }
  this.doSend(data);
  return true;
}
```

**New binary dispatch pattern** (from pty-test.tsx lines 174-183, to be extracted into WebSocketManager):
```typescript
// From apps/web/src/pages/pty-test.tsx lines 174-183
const view = new Uint8Array(event.data);
if (view.length < 2) return;
const sidLen = view[0];
if (view.length < 1 + sidLen) return;
const frameSid = new TextDecoder().decode(view.subarray(1, 1 + sidLen));
const ptyData = view.subarray(1 + sidLen);
```

---

### `apps/web/src/services/relay-client.ts` (service, request-response)

**Analog:** `apps/feishu/src/services/relay-client.ts` -- **DIRECT COPY**

**D-13:** No Taro dependency. Copy entire file. Only change needed: `@/services/websocket` import path stays the same since web uses same @/ alias.

**Full source** (lines 1-131) -- copy verbatim. The only import is:
```typescript
import type { WebSocketManager } from "@/services/websocket";
import type { MessageEnvelope, RelayControlMessage } from "@cc-anywhere/shared";
```

---

### `apps/web/src/services/ensure-binding.ts` (service, request-response)

**Analog:** `apps/feishu/src/services/ensure-binding.ts` -- **DIRECT COPY**

**D-13:** No Taro dependency. Copy entire file verbatim (lines 1-57). Only import is:
```typescript
import type { RelayClient } from "./relay-client";
```

---

### `apps/web/src/services/phase-machine.ts` (service, event-driven)

**Analog:** `apps/feishu/src/phase-machine.ts`

**Key transformation:** Dissolve `PhaseNav` interface (D-09). Replace all dependency-injected parameters with direct imports.

**Source signature** (lines 32-39):
```typescript
export function handleWsStatusChange(
  connected: boolean,
  getState: () => AppState,
  dispatch: Dispatch,
  timers: Timers,
  relay: PhaseRelay,
  nav: PhaseNav,
): void {
```

**Target signature:**
```typescript
export function handleWsStatusChange(
  connected: boolean,
  timers: Timers,
  relay: RelayClient,
): void {
  // Use useAppStore.getState() directly instead of getState parameter
  // Use useAppStore.setState() / useAppStore.getState().setPhase() instead of dispatch
  // Use router.navigate() instead of nav.reLaunch/navigateTo
  // Use localStorage.getItem() instead of nav.getStorageSync
  // Use useToastStore.getState().showToast() instead of nav.showToast
```

**Source Taro navigation calls to replace** (lines 70-71):
```typescript
nav.reLaunch("/pages/proxy-select/index");
// -> router.navigate("/")
```

**Source Taro navigation** (line 139):
```typescript
nav.navigateTo(`/pages/chat/index?sessionId=${savedSessionId}&mode=${mode}`);
// -> router.navigate(`/chat/${savedSessionId}?mode=${mode}`)
```

**Source Taro storage calls** (lines 122, 131, 135):
```typescript
nav.getStorageSync("cc_proxyId")     -> localStorage.getItem("cc_proxyId")
nav.getStorageSync("cc_sessionId")   -> localStorage.getItem("cc_sessionId")
nav.getStorageSync("cc_sessionMode") -> localStorage.getItem("cc_sessionMode")
nav.removeStorageSync("cc_sessionId") -> localStorage.removeItem("cc_sessionId")
```

**Source dispatch calls** (line 40):
```typescript
dispatch({ type: "SET_CONNECTED", connected });
// -> useAppStore.getState().setConnected(connected)
```

**Source Timers interface** (lines 8-11) -- preserve:
```typescript
export interface Timers {
  reconnect: ReturnType<typeof setTimeout> | null;
  coldStartDone: boolean;
}
```

**Source cold start logic** (lines 120-151) -- preserve logic, replace nav/dispatch calls.

**Source reconnect fallback logic** (lines 64-73) -- preserve the 10s timeout that resets to connecting state.

---

### `apps/web/src/lib/router.ts` (config, request-response)

**No direct analog in codebase.** Pattern from RESEARCH.md Pattern 4.

**Current manual hash routing** in `apps/web/src/app.tsx` (lines 6-18):
```typescript
const [route, setRoute] = useState(window.location.hash);
useEffect(() => {
  const handler = () => setRoute(window.location.hash);
  window.addEventListener("hashchange", handler);
  return () => window.removeEventListener("hashchange", handler);
}, []);
if (route === "#/pty-test") {
  return <PtyTest />;
}
```

**Target pattern:**
```typescript
import { createHashRouter } from 'react-router';
// Import page components
export const router = createHashRouter([
  {
    path: '/',
    children: [
      { index: true, element: /* ProxySelectPage */ },
      { path: 'sessions', element: /* SessionListPage */ },
      { path: 'chat/:id', element: /* ChatPage */ },
      { path: 'pty-test', element: /* PtyTest */ },
      { path: 'tokens', element: /* TokenShowcase */ },
    ],
  },
]);
```

**Critical:** This module must be importable by `phase-machine.ts` without circular dependency. Page components import stores, stores do NOT import router.

---

### `apps/web/src/hooks/use-relay-setup.ts` (hook, event-driven)

**Analog:** `apps/feishu/src/app.tsx` (lines 67-105) -- the initialization useEffect

**Source initialization pattern** (lines 67-105):
```typescript
useEffect(() => {
  const relayUrl = Taro.getStorageSync("cc_relayUrl") as string || DEFAULT_RELAY_URL;
  dispatch({ type: "SET_RELAY_URL", url: relayUrl });

  const ws = new WebSocketManager();
  wsRef.current = ws;
  const relay = new RelayClient(ws, state.clientId);
  setRelayClient(relay);

  const getState = () => stateRef.current;
  const nav = { /* PhaseNav impl */ };

  ws.onStatusChange((connected) => {
    handleWsStatusChange(connected, getState, dispatch, timersRef.current, relay, nav);
  });
  ws.connect(relayUrl);

  const unsub = relay.onMessage((msg) => {
    void handleRelayMessage(msg as Record<string, unknown>, getState, dispatch, timersRef.current, relay, nav);
  });

  return () => {
    unsub();
    ws.close();
  };
}, []);
```

**Target pattern:** Single hook `useRelaySetup()` that:
1. Creates `WebSocketManager` singleton
2. Creates `RelayClient` using `useAppStore.getState().clientId`
3. Resolves relay URL (D-18 priority chain)
4. Wires `ws.onStatusChange` -> `handleWsStatusChange`
5. Wires `relay.onMessage` -> `handleRelayMessage`
6. Connects WebSocket
7. Sets up `visibilitychange` listener (D-08)
8. Returns cleanup function

**Source visibilitychange pattern** (`apps/feishu/src/app.tsx` lines 108-114, using Taro.useDidShow):
```typescript
Taro.useDidShow(() => {
  const ws = wsRef.current;
  if (ws && !ws.isConnected()) {
    const url = Taro.getStorageSync("cc_relayUrl") as string || DEFAULT_RELAY_URL;
    ws.connect(url);
  }
});
```

**Target:** Replace with `document.addEventListener('visibilitychange', ...)`.

---

### `apps/web/src/pages/proxy-select.tsx` (component, placeholder)

**Analog:** `apps/web/src/pages/pty-test.tsx` (for layout/styling patterns)

**Source page layout pattern** (pty-test.tsx lines 243-301):
```typescript
return (
  <div className="flex flex-col h-screen bg-[var(--background)]">
    <div className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-[var(--card)] border-b border-[var(--border)]">
      {/* status bar content */}
    </div>
    <div className="flex-1 overflow-auto">
      {/* page content */}
    </div>
  </div>
);
```

**Target:** D-16 placeholder page showing debug info: current route name, phase-machine state, WebSocket status, selected proxy, etc. Use same Tailwind design tokens from `app.css`.

---

### `apps/web/src/pages/session-list.tsx` (component, placeholder)

**Analog:** Same as proxy-select.tsx -- placeholder debug page using same layout pattern.

---

### `apps/web/src/pages/chat.tsx` (component, placeholder)

**Analog:** Same layout pattern. Also needs `useParams` from react-router to read `:id` and `useSearchParams` for `?mode=pty`.

---

### `apps/web/src/components/toast.tsx` (component, event-driven)

**Analog:** `apps/feishu/src/components/toast/index.tsx`

**Source DOM-based toast** (lines 20-48):
```typescript
function createToastElement(message: string, duration: number, type: ToastType = "info"): void {
  const container = getOrCreateContainer();
  const item = document.createElement("div");
  item.className = `toast-item toast-item-enter${type === "error" ? " toast-item-error" : ""}`;
  item.textContent = message;
  container.appendChild(item);
  setTimeout(() => {
    item.className = item.className.replace("toast-item-enter", "toast-item-exit");
    setTimeout(() => item.remove(), 300);
  }, duration);
}
```

**Target:** React component driven by `useToastStore`. Render `toasts` array as positioned fixed divs. CSS animation from `app.css` design tokens. D-17 says Phase 10 replaces with shadcn/ui toast.

---

### `apps/web/src/app.tsx` (config, event-driven) -- REWRITE

**Analog:** `apps/feishu/src/app.tsx` (for initialization flow)

**Source Provider nesting** (lines 116-138) -- this exact pattern is eliminated by zustand:
```typescript
<RelayClientProvider value={relayClient}>
  <AppProvider value={state}>
    <AppDispatchProvider value={dispatch}>
      <SessionProvider value={sessionState}>
        {/* 8 levels deep */}
```

**Target:** Flat structure with `RouterProvider` + `useRelaySetup` hook + Toast component:
```typescript
import { RouterProvider } from 'react-router';
import { router } from '@/lib/router';
import { useRelaySetup } from '@/hooks/use-relay-setup';
import { Toast } from '@/components/toast';

export function App() {
  useRelaySetup();
  return (
    <>
      <RouterProvider router={router} />
      <Toast />
    </>
  );
}
```

---

### `apps/web/src/pages/pty-test.tsx` (component, streaming) -- MODIFY

**Analog:** `apps/web/src/pages/pty-test.tsx` (current, self)

**Current independent WebSocket** (lines 145-226) -- to be replaced with unified WebSocketManager.

**Current binary frame parsing** (lines 174-183) -- move to WebSocketManager.dispatchBinary():
```typescript
const view = new Uint8Array(event.data);
if (view.length < 2) return;
const sidLen = view[0];
if (view.length < 1 + sidLen) return;
const frameSid = new TextDecoder().decode(view.subarray(1, 1 + sidLen));
if (sessionId && frameSid !== sessionId) return;
const ptyData = view.subarray(1 + sidLen);
terminalRef.current?.write(ptyData);
```

**Target:** Remove direct WebSocket code. Use `wsManager.subscribeBinary(sessionId, handler)` from the unified WebSocketManager. The auto-select proxy logic (lines 190-208) can be preserved but routed through the shared RelayClient.

---

### Config Files (modify)

**`apps/web/vite.config.ts`** -- already has `@/` alias (line 10). No change needed.

**`apps/web/tsconfig.app.json`** -- already has `@/*` path mapping (line 13). No change needed.

**`apps/web/package.json`** -- add `zustand` dependency. Possibly `@redux-devtools/extension` as devDependency.

---

## Shared Patterns

### Zustand Store Creation
**Source pattern:** All 6 Feishu stores use Context + useReducer
**Apply to:** All `apps/web/src/stores/*.ts` files

```typescript
// Standard zustand store shape for this project
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface XxxStoreState {
  // state fields
  field: Type;
  // action methods colocated
  setField: (value: Type) => void;
}

export const useXxxStore = create<XxxStoreState>()(
  devtools(
    (set, get) => ({
      field: initialValue,
      setField: (value) => set({ field: value }),
    }),
    { name: 'xxx-store' },
  ),
);
```

**Component-external access** (for phase-machine):
```typescript
useXxxStore.getState().setField(value);
useXxxStore.setState({ field: value });
```

### Taro API Replacements
**Apply to:** `app-store.ts`, `phase-machine.ts`, `hooks/use-relay-setup.ts`

| Taro API | Browser API |
|----------|-------------|
| `Taro.getStorageSync(key)` | `localStorage.getItem(key)` |
| `Taro.setStorageSync(key, val)` | `localStorage.setItem(key, val)` |
| `Taro.removeStorageSync(key)` | `localStorage.removeItem(key)` |
| `Taro.reLaunch({ url })` | `router.navigate(path)` |
| `Taro.navigateTo({ url })` | `router.navigate(path)` |
| `Taro.getCurrentPages()` | `window.location.hash` |
| `Taro.useDidShow()` | `document.addEventListener('visibilitychange', ...)` |

### Taro Route Path Mapping
**Apply to:** `phase-machine.ts`, `lib/router.ts`

| Taro Path | Web Path |
|-----------|----------|
| `/pages/proxy-select/index` | `/` |
| `/pages/session-list/index` | `/sessions` |
| `/pages/chat/index?sessionId=X&mode=M` | `/chat/X?mode=M` |

### Import Convention
**Source:** `apps/web/src/components/ui/button.tsx` line 5, `apps/web/vite.config.ts` line 10
**Apply to:** All new files

```typescript
import { cn } from "@/lib/utils";           // @/ alias to src/
import type { ProxyInfo } from "@cc-anywhere/shared"; // shared package
```

### Error Handling
**Source:** `apps/feishu/src/services/relay-client.ts` lines 22-24
**Apply to:** All service files

```typescript
try {
  parsed = JSON.parse(raw) as MessageEnvelope | RelayControlMessage;
} catch (e) {
  console.warn("RelayClient: failed to parse JSON:", raw.slice(0, 200), e);
  return;
}
```

No silent fallbacks. Log with context (class/function name, data snippet). Use `console.warn` for recoverable, `console.error` for non-recoverable.

### Test Pattern
**Source:** `apps/feishu/src/__tests__/session-store.test.ts`, `apps/feishu/src/__tests__/app-store.test.ts`
**Apply to:** All `apps/web/src/__tests__/unit/stores/*.test.ts` and `apps/web/src/__tests__/unit/services/*.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
// For zustand stores: import the store, call actions, assert state
// For services: mock dependencies with vi.fn()
```

**Feishu test helper pattern** (phase-machine.test.ts lines 15-45):
```typescript
function createTestEnv(phase: AppPhase, overrides?: Partial<AppState>) {
  // Create controlled test environment with mock nav/relay
}
```

**Web adaptation:** Since phase-machine now directly imports zustand stores and router, tests will need to:
1. Reset zustand stores between tests: `useAppStore.setState(initialState)`
2. Mock `@/lib/router` module to provide mock `navigate`
3. No more `PhaseNav` mock (interface dissolved)

**Test directory structure:**
```
apps/web/src/__tests__/unit/
  stores/
    app-store.test.ts
    session-store.test.ts
    chat-store.test.ts
  services/
    websocket.test.ts
    phase-machine.test.ts
```

**Vitest config** (`apps/web/vitest.config.ts` lines 16-29) already supports `@/` alias and `jsdom` environment.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| -- | -- | -- | All files have analogs (Feishu sources or existing web files) |

All 21 files have clear analogs in either the Feishu codebase (migration source) or existing web app files. No files require patterns from RESEARCH.md alone.

## Metadata

**Analog search scope:** `apps/feishu/src/`, `apps/web/src/`, `packages/shared/src/`
**Files scanned:** 35+ source files across feishu, web, and shared packages
**Pattern extraction date:** 2026-04-16
