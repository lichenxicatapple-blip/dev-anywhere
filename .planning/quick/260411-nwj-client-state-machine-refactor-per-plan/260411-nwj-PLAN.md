---
type: quick
description: "Client state machine refactor: AppPhase enum, centralize Storage, fix reducer side effects, eliminate duplicate state, sync navigation with phase, unify cold start"
files_modified:
  - apps/feishu/src/stores/app-store.ts
  - apps/feishu/src/stores/terminal-store.ts
  - apps/feishu/src/stores/session-store.ts
  - apps/feishu/src/app.tsx
  - apps/feishu/src/pages/proxy-select/index.tsx
  - apps/feishu/src/pages/session-list/index.tsx
  - apps/feishu/src/pages/chat/index.tsx
  - apps/feishu/src/components/safe-area-header/index.tsx
  - apps/feishu/src/__tests__/app-store.test.ts
autonomous: true
must_haves:
  truths:
    - "AppPhase enum replaces boolean combination for stage identification"
    - "All Storage writes/clears are centralized via transitionToPhase helper, not scattered in component lifecycle"
    - "terminal-store reducer is a pure function with no Taro.setStorageSync calls"
    - "No duplicate state: historySessions lives in session-store, dirEntries only in file-store"
    - "Chat page relay handler deps do not include chatState.messages or terminalState.lines"
    - "Cold start logic runs in app.tsx, not in proxy-select page"
    - "Physical back button and swipe gestures correctly sync phase via useDidShow"
  artifacts:
    - path: "apps/feishu/src/stores/app-store.ts"
      provides: "AppPhase type, SET_PHASE action, transitionToPhase helper, cleanStorageForPhaseTransition helper"
      exports: ["AppPhase", "transitionToPhase", "cleanStorageForPhaseTransition"]
    - path: "apps/feishu/src/__tests__/app-store.test.ts"
      provides: "Unit tests for phase transitions and Storage cleanup logic"
  key_links:
    - from: "apps/feishu/src/app.tsx"
      to: "apps/feishu/src/stores/app-store.ts"
      via: "stateRef.current for stale closure fix, transitionToPhase for phase changes"
    - from: "apps/feishu/src/app.tsx"
      to: "apps/feishu/src/pages/proxy-select/cold-start.ts"
      via: "resolveColdStart called in proxy_list_response handler"
---

<objective>
Refactor the Feishu client state management to introduce an explicit AppPhase state machine, centralize localStorage management, fix reducer side effects, eliminate duplicate state, and unify cold start logic in app.tsx.

Purpose: The current client state uses scattered boolean combinations (connected + proxyOnline + selectedProxyId) to determine app phase, with Storage operations spread across component lifecycles that behave differently between H5 and mini program. This refactor makes state transitions explicit and predictable.

Output: Clean state machine with AppPhase enum, pure reducers, centralized Storage, no duplicate state, and unified cold start.
</objective>

<execution_context>
@.planning/notes/2026-04-11-state-machine-refactor-plan.md
</execution_context>

<context>
@apps/feishu/src/stores/app-store.ts
@apps/feishu/src/stores/terminal-store.ts
@apps/feishu/src/stores/session-store.ts
@apps/feishu/src/stores/file-store.ts
@apps/feishu/src/stores/chat-store.ts
@apps/feishu/src/app.tsx
@apps/feishu/src/pages/proxy-select/index.tsx
@apps/feishu/src/pages/proxy-select/cold-start.ts
@apps/feishu/src/pages/session-list/index.tsx
@apps/feishu/src/pages/chat/index.tsx
@apps/feishu/src/components/safe-area-header/index.tsx
@apps/feishu/src/services/websocket.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fix reducer side effect + chat stale closure (Step 5 from plan)</name>
  <files>apps/feishu/src/stores/terminal-store.ts, apps/feishu/src/pages/chat/index.tsx</files>
  <action>
**5a. terminal-store reducer purity:**

In `apps/feishu/src/stores/terminal-store.ts`, remove the `Taro.setStorageSync("cc_fontSizeIndex", idx)` call from the `SET_FONT_SIZE_INDEX` case in `terminalReducer`. The reducer must be a pure function. The case should only compute and return the new state:

```typescript
case "SET_FONT_SIZE_INDEX": {
  const idx = Math.max(0, Math.min(action.index, FONT_SIZES.length - 1));
  return { ...state, fontSizeIndex: idx, fontSize: FONT_SIZES[idx] };
}
```

In `apps/feishu/src/pages/chat/index.tsx`, add a useEffect that persists fontSizeIndex to Storage whenever it changes:

```typescript
useEffect(() => {
  Taro.setStorageSync("cc_fontSizeIndex", terminalState.fontSizeIndex);
}, [terminalState.fontSizeIndex]);
```

Place this after the existing `useEffect(() => { return () => { Taro.removeStorageSync("cc_sessionId"); }; }, []);` block.

**5b. Chat relay handler stale closure fix:**

In `apps/feishu/src/pages/chat/index.tsx`, the relay.onMessage useEffect (line ~85-189) has deps `[relay, sessionId, chatState.messages, chatDispatch, terminalDispatch, terminalState.lines]`. The `chatState.messages` and `terminalState.lines` deps cause the handler to re-register on every message, risking stale closure and missed messages during streaming.

Fix: Add refs for chatState and terminalState at the top of the Chat component (after the useReducer calls):

```typescript
const chatStateRef = useRef(chatState);
chatStateRef.current = chatState;
const terminalStateRef = useRef(terminalState);
terminalStateRef.current = terminalState;
```

In the relay.onMessage handler, replace direct reads of `chatState.messages` with `chatStateRef.current.messages` and `terminalState.lines` with `terminalStateRef.current.lines`. Specifically:
- Line ~119: `const msgs = chatState.messages;` becomes `const msgs = chatStateRef.current.messages;`
- Line ~163: `const merged = [...terminalState.lines];` becomes `const merged = [...terminalStateRef.current.lines];`

Remove `chatState.messages` and `terminalState.lines` from the useEffect deps array. The final deps should be: `[relay, sessionId, chatDispatch, terminalDispatch]`.

Add `useRef` to the import from "react" if not already there.
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter feishu run test</automated>
  </verify>
  <done>terminal-store reducer has zero Taro calls; chat relay handler deps do not include messages/lines; font size still persists to Storage via useEffect.</done>
</task>

<task type="auto">
  <name>Task 2: Eliminate duplicate state (Step 4 from plan)</name>
  <files>apps/feishu/src/stores/session-store.ts, apps/feishu/src/pages/session-list/index.tsx</files>
  <action>
**4a. Move historySessions from session-list useState into session-store:**

The session-store already has `historySessions: HistorySession[]` in its state and a `SET_HISTORY_SESSIONS` action. But `session-list/index.tsx` uses a local `useState<HistorySession[]>([])` instead (line 24). Fix:

In `apps/feishu/src/pages/session-list/index.tsx`:
- Remove `const [historySessions, setHistorySessions] = useState<HistorySession[]>([]);` (line 24)
- Remove `HistorySession` from the import of `@cc-anywhere/shared` (it's already re-exported from session-store)
- In the relay.onMessage handler, replace `setHistorySessions(ctrl.sessions)` with `sessionDispatch({ type: "SET_HISTORY_SESSIONS", sessions: ctrl.sessions })`
- Replace all reads of local `historySessions` with `sessionState.historySessions`
- Update `hasHistory` to use `sessionState.historySessions.length > 0`
- Update the `.map` over historySessions to use `sessionState.historySessions.map`

**4b. Eliminate duplicate dirEntries:**

In `apps/feishu/src/pages/session-list/index.tsx`:
- Remove `const [dirEntries, setDirEntries] = useState<Map<string, DirEntry[]>>(new Map());` (line 27)
- Add imports: `import { useFileState, useFileDispatch } from "@/stores/file-store";`
- Add at component top: `const fileState = useFileState();` and `const fileDispatch = useFileDispatch();`
- In the relay.onMessage handler, replace the `dir_list_response` case that calls `setDirEntries` with: `fileDispatch({ type: "SET_DIR_ENTRIES", path, entries });`
- Pass `fileState.tree` to `<DirectoryPicker dirEntries={fileState.tree} ... />` instead of the local `dirEntries`
- Remove `DirEntry` from the `@cc-anywhere/shared` import if no longer used directly
- Clean up unused imports (`useState` may still be needed for `swipeOpenId` and `showDirPicker`)
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter feishu run test</automated>
  </verify>
  <done>session-list has no local historySessions or dirEntries state; both read from their respective stores. No duplicate state sources.</done>
</task>

<task type="auto">
  <name>Task 3: Introduce AppPhase enum and SET_PHASE action (Step 1 from plan)</name>
  <files>apps/feishu/src/stores/app-store.ts, apps/feishu/src/__tests__/app-store.test.ts</files>
  <action>
**3a. Extend AppState with phase:**

In `apps/feishu/src/stores/app-store.ts`:

Add the AppPhase type at the top of the file (after imports):

```typescript
export type AppPhase =
  | "connecting"
  | "reconnecting"
  | "proxy_selecting"
  | "session_browsing"
  | "chatting"
  | "proxy_lost";
```

Extend `AppState` interface with two new fields:

```typescript
export interface AppState {
  phase: AppPhase;
  phaseBeforeDisconnect: AppPhase | null;
  connected: boolean;
  proxyOnline: boolean;
  selectedProxyId: string | null;
  selectedProxyName: string | null;
  clientId: string;
  relayUrl: string;
}
```

Add `SET_PHASE` to `AppAction`:

```typescript
export type AppAction =
  | { type: "SET_CONNECTED"; connected: boolean }
  | { type: "SET_PROXY"; proxyId: string | null; proxyName: string | null }
  | { type: "SET_PROXY_ONLINE"; online: boolean }
  | { type: "SET_RELAY_URL"; url: string }
  | { type: "SET_PHASE"; phase: AppPhase };
```

Update `initialAppState`:

```typescript
export const initialAppState: AppState = {
  phase: "connecting",
  phaseBeforeDisconnect: null,
  connected: false,
  proxyOnline: false,
  selectedProxyId: null,
  selectedProxyName: null,
  clientId: loadClientId(),
  relayUrl: "",
};
```

Add `SET_PHASE` case to `appReducer` (pure, no side effects):

```typescript
case "SET_PHASE": {
  const next = action.phase;
  const phaseBeforeDisconnect =
    (next === "reconnecting" || next === "proxy_lost") ? state.phase : state.phaseBeforeDisconnect;
  return { ...state, phase: next, phaseBeforeDisconnect };
}
```

**3b. Add Storage cleanup helper and transitionToPhase (exported, not in reducer):**

Add these exported functions after the reducer:

```typescript
export function cleanStorageForPhaseTransition(prev: AppPhase, next: AppPhase): void {
  if (next === "proxy_selecting") {
    Taro.removeStorageSync("cc_proxyId");
    Taro.removeStorageSync("cc_sessionId");
  }
  if (next === "session_browsing" && (prev === "chatting" || prev === "proxy_lost")) {
    Taro.removeStorageSync("cc_sessionId");
  }
}

export function transitionToPhase(
  prev: AppPhase,
  next: AppPhase,
  dispatch: React.Dispatch<AppAction>,
): void {
  cleanStorageForPhaseTransition(prev, next);
  dispatch({ type: "SET_PHASE", phase: next });
}
```

**3c. Unit tests:**

Create `apps/feishu/src/__tests__/app-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appReducer, initialAppState, cleanStorageForPhaseTransition } from "@/stores/app-store";
import type { AppState, AppPhase } from "@/stores/app-store";
import Taro from "@tarojs/taro";

vi.mock("@tarojs/taro", () => ({
  default: {
    getStorageSync: vi.fn(() => ""),
    setStorageSync: vi.fn(),
    removeStorageSync: vi.fn(),
  },
}));

function stateWith(phase: AppPhase, overrides?: Partial<AppState>): AppState {
  return { ...initialAppState, phase, ...overrides };
}

describe("appReducer SET_PHASE", () => {
  it("updates phase", () => {
    const next = appReducer(stateWith("connecting"), { type: "SET_PHASE", phase: "proxy_selecting" });
    expect(next.phase).toBe("proxy_selecting");
  });

  it("records phaseBeforeDisconnect when entering reconnecting", () => {
    const next = appReducer(stateWith("chatting"), { type: "SET_PHASE", phase: "reconnecting" });
    expect(next.phase).toBe("reconnecting");
    expect(next.phaseBeforeDisconnect).toBe("chatting");
  });

  it("records phaseBeforeDisconnect when entering proxy_lost", () => {
    const next = appReducer(stateWith("session_browsing"), { type: "SET_PHASE", phase: "proxy_lost" });
    expect(next.phaseBeforeDisconnect).toBe("session_browsing");
  });

  it("preserves phaseBeforeDisconnect on normal transitions", () => {
    const state = stateWith("reconnecting", { phaseBeforeDisconnect: "chatting" });
    const next = appReducer(state, { type: "SET_PHASE", phase: "proxy_selecting" });
    expect(next.phaseBeforeDisconnect).toBe("chatting");
  });
});

describe("cleanStorageForPhaseTransition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears proxyId and sessionId when transitioning to proxy_selecting", () => {
    cleanStorageForPhaseTransition("chatting", "proxy_selecting");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_proxyId");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_sessionId");
  });

  it("clears sessionId when transitioning from chatting to session_browsing", () => {
    cleanStorageForPhaseTransition("chatting", "session_browsing");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_sessionId");
    expect(Taro.removeStorageSync).not.toHaveBeenCalledWith("cc_proxyId");
  });

  it("clears sessionId when transitioning from proxy_lost to session_browsing", () => {
    cleanStorageForPhaseTransition("proxy_lost", "session_browsing");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_sessionId");
  });

  it("does not clear anything for session_browsing to chatting", () => {
    cleanStorageForPhaseTransition("session_browsing", "chatting");
    expect(Taro.removeStorageSync).not.toHaveBeenCalled();
  });

  it("does not clear anything for connecting to proxy_selecting", () => {
    cleanStorageForPhaseTransition("connecting", "proxy_selecting");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_proxyId");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_sessionId");
  });
});
```
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter feishu run test</automated>
  </verify>
  <done>AppPhase type exported; SET_PHASE reducer case is pure; transitionToPhase and cleanStorageForPhaseTransition exported and tested; all existing tests still pass.</done>
</task>

<task type="auto">
  <name>Task 4: Sync navigation with phase + stale closure fix in app.tsx (Step 2 from plan)</name>
  <files>apps/feishu/src/app.tsx, apps/feishu/src/pages/proxy-select/index.tsx, apps/feishu/src/pages/session-list/index.tsx, apps/feishu/src/pages/chat/index.tsx, apps/feishu/src/components/safe-area-header/index.tsx</files>
  <action>
**4a. app.tsx stale closure fix and phase-aware event handling:**

In `apps/feishu/src/app.tsx`:

Add imports for the new phase types/helpers:
```typescript
import {
  AppProvider, AppDispatchProvider,
  appReducer, initialAppState,
  transitionToPhase,
} from "@/stores/app-store";
import type { AppPhase } from "@/stores/app-store";
```

Add `useRef` to the React import.

After `const [state, dispatch] = useReducer(appReducer, initialAppState);`, add:

```typescript
const stateRef = useRef(state);
stateRef.current = state;
const proxyLostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const coldStartDoneRef = useRef(false);
```

Rewrite the `ws.onStatusChange` handler inside useEffect to be phase-aware:

```typescript
ws.onStatusChange((connected) => {
  dispatch({ type: "SET_CONNECTED", connected });
  const s = stateRef.current;
  if (connected) {
    relay.register();
    relay.listProxies();
    // If reconnecting, clear the timeout but don't restore phase yet
    // Phase restoration happens in proxy_list_response after proxy validation
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  } else {
    dispatch({ type: "SET_PROXY_ONLINE", online: false });
    // Enter reconnecting state if we were past connecting
    if (s.phase !== "connecting") {
      dispatch({ type: "SET_PHASE", phase: "reconnecting" });
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        transitionToPhase(stateRef.current.phase, "connecting", dispatch);
        Taro.reLaunch({ url: "/pages/proxy-select/index" });
      }, 10000);
    }
  }
});
```

Rewrite the `relay.onMessage` handler to be phase-aware. Use `stateRef.current` instead of `state`:

```typescript
const unsub = relay.onMessage((msg) => {
  const ctrl = msg as Record<string, unknown>;
  const s = stateRef.current;

  if (ctrl.type === "proxy_offline" && ctrl.proxyId === s.selectedProxyId) {
    dispatch({ type: "SET_PROXY_ONLINE", online: false });
    dispatch({ type: "SET_PHASE", phase: "proxy_lost" });
    Taro.showToast({ title: "Proxy disconnected", icon: "none", duration: 1500 });
    proxyLostTimerRef.current = setTimeout(() => {
      proxyLostTimerRef.current = null;
      transitionToPhase(stateRef.current.phase, "proxy_selecting", dispatch);
      Taro.reLaunch({ url: "/pages/proxy-select/index" });
    }, 1500);
  }

  if (ctrl.type === "proxy_online" && ctrl.proxyId === s.selectedProxyId) {
    if (proxyLostTimerRef.current) {
      clearTimeout(proxyLostTimerRef.current);
      proxyLostTimerRef.current = null;
      dispatch({ type: "SET_PHASE", phase: s.phaseBeforeDisconnect ?? "session_browsing" });
    }
    dispatch({ type: "SET_PROXY_ONLINE", online: true });
    Taro.showToast({ title: "Proxy reconnected", icon: "none", duration: 1500 });
  }

  if (ctrl.type === "proxy_list_response") {
    const proxies = ctrl.proxies as ProxyInfo[];

    // Cold start: only on first proxy_list_response while in proxy_selecting
    if (!coldStartDoneRef.current && s.phase === "proxy_selecting") {
      coldStartDoneRef.current = true;
      const result = resolveColdStart(
        Taro.getStorageSync("cc_proxyId") as string,
        Taro.getStorageSync("cc_sessionId") as string,
        proxies,
      );
      if (result) {
        dispatch({ type: "SET_PROXY", proxyId: result.proxy.proxyId, proxyName: result.proxy.name || null });
        dispatch({ type: "SET_PROXY_ONLINE", online: true });
        relay.selectProxy(result.proxy.proxyId);
        const targetPhase: AppPhase = result.url.includes("chat") ? "chatting" : "session_browsing";
        dispatch({ type: "SET_PHASE", phase: targetPhase });
        Taro.navigateTo({ url: result.url });
        return;
      }
    }

    // Normal proxy list handling: update online status
    if (s.selectedProxyId) {
      const selected = proxies.find((p) => p.proxyId === s.selectedProxyId);
      dispatch({ type: "SET_PROXY_ONLINE", online: selected?.online ?? false });

      // Reconnection validation
      if (s.phase === "reconnecting") {
        if (selected?.online) {
          transitionToPhase(s.phase, s.phaseBeforeDisconnect ?? "session_browsing", dispatch);
        } else {
          transitionToPhase(s.phase, "proxy_selecting", dispatch);
          Taro.reLaunch({ url: "/pages/proxy-select/index" });
        }
      }
    }
  }
});
```

Add import for resolveColdStart:
```typescript
import { resolveColdStart } from "@/pages/proxy-select/cold-start";
```

Also update the `ws.onStatusChange` initial connected handler: when connected and phase is "connecting", transition to "proxy_selecting":
In the `if (connected)` block, after `relay.listProxies()`, add:
```typescript
if (stateRef.current.phase === "connecting") {
  dispatch({ type: "SET_PHASE", phase: "proxy_selecting" });
}
```

**4b. proxy-select: sync phase on user select + useDidShow fallback:**

In `apps/feishu/src/pages/proxy-select/index.tsx`:

Add import for `transitionToPhase` and `useAppDispatch` is already imported:
```typescript
import { useAppState, useAppDispatch, transitionToPhase } from "@/stores/app-store";
```

Remove the entire cold start block from the relay.onMessage handler (lines 52-68 in the current file). The `resolveColdStart` import and its usage are no longer needed here. Remove the import of `resolveColdStart` and `./cold-start`.

In `handleSelect`, add phase transition before navigation:
```typescript
const handleSelect = useCallback(
  (proxy: ProxyInfo) => {
    Taro.setStorageSync("cc_proxyId", proxy.proxyId);
    appDispatch({ type: "SET_PROXY", proxyId: proxy.proxyId, proxyName: proxy.name || null });
    appDispatch({ type: "SET_PROXY_ONLINE", online: true });
    if (relay) relay.selectProxy(proxy.proxyId);
    transitionToPhase(appState.phase, "session_browsing", appDispatch);
    Taro.navigateTo({ url: "/pages/session-list/index" });
  },
  [relay, appDispatch, appState.phase],
);
```

Note: `transitionToPhase` here is redundant with SET_PHASE since we're going forward (no Storage to clear going proxy_selecting -> session_browsing), but it keeps the pattern consistent. The `appState.phase` in deps is safe because it's only read at call time via the closure.

Add useDidShow fallback (add `Taro.useDidShow` call):
```typescript
Taro.useDidShow(() => {
  const s = appState;
  if (s.phase !== "proxy_selecting" && s.phase !== "connecting" && s.phase !== "reconnecting") {
    appDispatch({ type: "SET_PHASE", phase: "proxy_selecting" });
  }
});
```

Note: `useDidShow` from Taro is used as `Taro.useDidShow`. This is already the pattern used in app.tsx.

**4c. session-list: sync phase on navigation + useDidShow fallback:**

In `apps/feishu/src/pages/session-list/index.tsx`:

Add import: `import { useAppState, useAppDispatch, transitionToPhase } from "@/stores/app-store";` (replace existing `useAppState` import).

Note: `useAppDispatch` is not currently imported in session-list. Add it.

In `handleSelectSession`, add phase transition:
```typescript
const handleSelectSession = useCallback(
  (sessionId: string, mode: "pty" | "json" | undefined) => {
    Taro.setStorageSync("cc_sessionId", sessionId);
    sessionDispatch({ type: "SET_CURRENT_SESSION", sessionId, mode: mode || "json" });
    transitionToPhase(appState.phase, "chatting", appDispatch);
    Taro.navigateTo({ url: `/pages/chat/index?sessionId=${sessionId}&mode=${mode || "json"}` });
  },
  [sessionDispatch, appState.phase, appDispatch],
);
```

In `handleResumeHistory`, add phase transition:
```typescript
const handleResumeHistory = useCallback(
  (historySession: HistorySession) => {
    if (!checkConnected()) return;
    if (relay) {
      relay.sendEnvelope({ type: "session_create", sessionId: "", payload: { resumeSessionId: historySession.id } } as never);
    }
    transitionToPhase(appState.phase, "chatting", appDispatch);
    Taro.navigateTo({ url: "/pages/chat/index" });
  },
  [relay, checkConnected, appState.phase, appDispatch],
);
```

In `handleDirSelect`, add phase transition:
```typescript
const handleDirSelect = useCallback(
  (cwd: string) => {
    setShowDirPicker(false);
    if (!checkConnected()) return;
    if (relay) {
      relay.sendEnvelope({ type: "session_create", sessionId: "", payload: { cwd } } as never);
    }
    transitionToPhase(appState.phase, "chatting", appDispatch);
    Taro.navigateTo({ url: "/pages/chat/index" });
  },
  [relay, checkConnected, appState.phase, appDispatch],
);
```

Add useDidShow fallback:
```typescript
Taro.useDidShow(() => {
  if (appState.phase !== "session_browsing") {
    appDispatch({ type: "SET_PHASE", phase: "session_browsing" });
  }
});
```

**4d. safe-area-header: phase-aware back:**

In `apps/feishu/src/components/safe-area-header/index.tsx`, the component currently does not know about phase. Keep it simple: the `onBack` callback from each page is responsible for setting phase. No changes needed to the SafeAreaHeader component itself, since pages pass `onBack` callbacks or use the default `Taro.navigateBack()`. The useDidShow fallback in each page will catch the phase sync.

No changes to safe-area-header.
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter feishu run test</automated>
  </verify>
  <done>All navigation paths dispatch SET_PHASE before navigating; app.tsx uses stateRef for stale closure prevention; proxy_offline/online/reconnect are phase-aware with timer cancellation; useDidShow fallbacks ensure phase correctness on physical back/swipe; cold start logic runs in app.tsx.</done>
</task>

<task type="auto">
  <name>Task 5: Remove component lifecycle Storage operations (Step 3 from plan)</name>
  <files>apps/feishu/src/pages/session-list/index.tsx, apps/feishu/src/pages/chat/index.tsx</files>
  <action>
In `apps/feishu/src/pages/session-list/index.tsx`, delete the useEffect that removes cc_proxyId on unmount:

```typescript
// DELETE this entire block (currently around line 30):
useEffect(() => {
  return () => { Taro.removeStorageSync("cc_proxyId"); };
}, []);
```

Storage cleanup for cc_proxyId is now handled by `cleanStorageForPhaseTransition` when phase transitions to proxy_selecting (via transitionToPhase or useDidShow).

In `apps/feishu/src/pages/chat/index.tsx`, delete the useEffect that removes cc_sessionId on unmount:

```typescript
// DELETE this entire block (currently around line 62):
useEffect(() => {
  return () => { Taro.removeStorageSync("cc_sessionId"); };
}, []);
```

Storage cleanup for cc_sessionId is now handled by `cleanStorageForPhaseTransition` when phase transitions to session_browsing or proxy_selecting.
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter feishu run test</automated>
  </verify>
  <done>No component unmount performs Storage removal; all Storage cleanup is centralized in cleanStorageForPhaseTransition called by transitionToPhase and phase-transition dispatch points.</done>
</task>

<task type="auto">
  <name>Task 6: Final validation and TypeScript check</name>
  <files>apps/feishu/src/stores/app-store.ts, apps/feishu/src/app.tsx</files>
  <action>
Run TypeScript compilation to verify no type errors across the feishu app:

```bash
pnpm --filter feishu exec tsc --noEmit
```

Run full test suite to verify no regressions:

```bash
pnpm --filter feishu run test
```

If there are type errors, fix them. Common issues to watch for:
- `useAppDispatch` not imported in session-list (should have been added in Task 4)
- `appState.phase` property not recognized if AppState extension was incomplete
- `HistorySession` import needed from session-store instead of @cc-anywhere/shared in session-list
- `useRef` not imported in chat/index.tsx or app.tsx

Verify the proxy-select page no longer imports from `./cold-start` (moved to app.tsx).

Verify that `apps/feishu/src/pages/proxy-select/cold-start.ts` still exists unchanged (it's a pure function, only the caller moved).
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter feishu exec tsc --noEmit && pnpm --filter feishu run test</automated>
  </verify>
  <done>TypeScript compiles with zero errors; all tests pass including new app-store phase tests; cold-start.ts unchanged; no component lifecycle Storage operations remain.</done>
</task>

</tasks>

<verification>
1. `pnpm --filter feishu run test` -- all tests pass (existing 103 + new app-store tests)
2. `pnpm --filter feishu exec tsc --noEmit` -- zero type errors
3. Grep verification: `grep -r "removeStorageSync" apps/feishu/src/pages/` returns zero matches (all Storage cleanup centralized)
4. Grep verification: `grep -r "Taro\.\(set\|remove\)StorageSync" apps/feishu/src/stores/` returns zero matches in reducers (only in app-store's exported helpers)
5. Grep verification: `grep "chatState\.messages\|terminalState\.lines" apps/feishu/src/pages/chat/index.tsx` should NOT appear in useEffect deps
</verification>

<success_criteria>
- AppPhase type with 6 states is exported from app-store
- SET_PHASE action exists in appReducer, pure (no side effects)
- transitionToPhase and cleanStorageForPhaseTransition are exported helpers
- app.tsx uses stateRef pattern -- no stale closures in ws/relay handlers
- Cold start logic executes in app.tsx proxy_list_response handler, not in proxy-select
- proxy-select, session-list, chat all dispatch SET_PHASE before navigation
- useDidShow fallback in proxy-select and session-list corrects phase on physical back
- No component unmount cleanup touches Storage
- terminal-store reducer is pure (no Taro calls)
- chat relay handler deps are [relay, sessionId, chatDispatch, terminalDispatch] only
- historySessions reads from session-store, not local useState
- dirEntries in session-list reads from file-store, not local useState
- All existing tests pass, new app-store tests pass, TypeScript compiles cleanly
</success_criteria>

<output>
After completion, verify with H5 preview (`pnpm --filter feishu run build:h5`) that:
- Cold start navigates correctly when cc_proxyId is in Storage
- Proxy selection navigates to session-list
- Back button returns to correct page
- Proxy offline shows toast and returns to proxy-select after 1.5s
</output>
