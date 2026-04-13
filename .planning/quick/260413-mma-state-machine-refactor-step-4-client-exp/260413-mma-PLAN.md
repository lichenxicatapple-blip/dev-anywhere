---
phase: quick-260413-mma
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/feishu/src/stores/app-store.ts
  - apps/feishu/src/phase-machine.ts
  - apps/feishu/src/pages/proxy-select/index.tsx
  - apps/feishu/src/pages/proxy-select/cold-start.ts
  - apps/feishu/src/pages/session-list/index.tsx
  - apps/feishu/src/__tests__/phase-machine.test.ts
  - apps/feishu/src/__tests__/cold-start.test.ts
  - apps/feishu/src/__tests__/app-store.test.ts
autonomous: true
requirements: [step-4-client-state-machine]
must_haves:
  truths:
    - "proxy_lost phase no longer exists in AppPhase type or anywhere in client code"
    - "registering phase exists: ws open -> registering -> register_response -> proxy_selecting"
    - "proxy offline only sets proxyOnline=false and shows toast, no page navigation"
    - "proxy online sets proxyOnline=true, no proxy_lost timer involved"
    - "cold start uses ensureBinding instead of separate resolveColdStart function"
    - "pages do not SET_PHASE -- useDidShow phase correction hacks removed from proxy-select and session-list"
    - "all phase-machine tests pass with new state transitions"
  artifacts:
    - path: "apps/feishu/src/stores/app-store.ts"
      provides: "Updated AppPhase with registering, without proxy_lost"
      contains: "registering"
    - path: "apps/feishu/src/phase-machine.ts"
      provides: "Rewritten state machine handlers"
    - path: "apps/feishu/src/__tests__/phase-machine.test.ts"
      provides: "Tests covering all new transitions"
  key_links:
    - from: "apps/feishu/src/phase-machine.ts"
      to: "apps/feishu/src/services/ensure-binding.ts"
      via: "cold start calls ensureBinding"
      pattern: "ensureBinding"
---

<objective>
Client state machine cleanup: remove proxy_lost phase, add registering phase, eliminate useDidShow hacks, replace cold-start.ts with ensureBinding-based flow.

Purpose: Align client state machine with design doc section 4. proxy offline should not trigger page navigation. Phase transitions are state-machine-driven, not page-driven.
Output: Clean client state machine matching the design, all tests updated.
</objective>

<execution_context>
@.planning/notes/2026-04-13-state-machine-design.md (section 4)
</execution_context>

<context>
@apps/feishu/src/stores/app-store.ts
@apps/feishu/src/phase-machine.ts
@apps/feishu/src/pages/proxy-select/cold-start.ts
@apps/feishu/src/pages/proxy-select/index.tsx
@apps/feishu/src/pages/session-list/index.tsx
@apps/feishu/src/services/ensure-binding.ts
@apps/feishu/src/services/relay-client.ts
@apps/feishu/src/app.tsx
@apps/feishu/src/__tests__/phase-machine.test.ts
@apps/feishu/src/__tests__/cold-start.test.ts
@apps/feishu/src/__tests__/app-store.test.ts

<interfaces>
From apps/feishu/src/services/ensure-binding.ts:
```typescript
export interface BindingContext {
  proxyId?: string;
  sessionId?: string;
}
export interface BindingSuccess { proxyId: string; }
export interface BindingError { error: string; }
export type BindingResult = BindingSuccess | BindingError;
export function isBindingError(result: BindingResult): result is BindingError;
export async function ensureBinding(relay: RelayClient, context: BindingContext): Promise<BindingResult>;
```

From apps/feishu/src/services/relay-client.ts:
```typescript
export class RelayClient {
  register(): void;
  listProxies(): void;
  selectProxy(proxyId: string): Promise<{ success: boolean; proxyId?: string; error?: string }>;
  requestProxyList(): Promise<Array<{ proxyId: string; name?: string; online: boolean; sessions?: string[] }>>;
  getBoundProxyId(): string | null;
  onMessage(handler: (msg: MessageEnvelope | RelayControlMessage) => void): () => void;
}
```

Relay sends `client_register_response` after `client_register`. Currently client ignores it.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Rewrite app-store and phase-machine for new state machine</name>
  <files>
    apps/feishu/src/stores/app-store.ts
    apps/feishu/src/phase-machine.ts
    apps/feishu/src/pages/proxy-select/cold-start.ts
    apps/feishu/src/pages/proxy-select/index.tsx
    apps/feishu/src/pages/session-list/index.tsx
  </files>
  <action>
**app-store.ts changes:**

1. Replace `AppPhase` type: remove `proxy_lost`, add `registering`:
```typescript
export type AppPhase =
  | "connecting"
  | "registering"
  | "reconnecting"
  | "proxy_selecting"
  | "session_browsing"
  | "chatting";
```

2. In `appReducer` SET_PHASE case: update `phaseBeforeDisconnect` recording -- only save on `reconnecting` transition (no more `proxy_lost`):
```typescript
const phaseBeforeDisconnect =
  next === "reconnecting" ? state.phase : state.phaseBeforeDisconnect;
```

3. In `cleanStorageForPhaseTransition`: remove the `proxy_lost` check from the session_browsing transition condition. Change `(prev === "chatting" || prev === "proxy_lost")` to just `prev === "chatting"`.

**phase-machine.ts changes -- complete rewrite of both handlers:**

Remove `import { resolveColdStart }` -- no longer needed. Import `ensureBinding` and `isBindingError` from `@/services/ensure-binding` instead.

Update `PhaseRelay` interface: add `requestProxyList` method (same signature as RelayClient.requestProxyList), since cold start now needs it for ensureBinding. Also add `getBoundProxyId(): string | null` for ensureBinding usage. Actually, since ensureBinding takes the full RelayClient, change the approach: the PhaseRelay interface should expose the full RelayClient-compatible surface needed by ensureBinding. The cleanest approach is to make the cold start path accept the relay directly. Add to PhaseRelay: `requestProxyList(): Promise<Array<{proxyId: string; name?: string; online: boolean; sessions?: string[]}>>` and `getBoundProxyId(): string | null`.

Remove `coldStartDone` from `Timers` interface. Replace with `coldStartDone: boolean` staying (it's still needed to prevent re-firing cold start). Keep Timers as: `{ proxyLost: null is REMOVED, reconnect, coldStartDone }`. Actually rename to just `{ reconnect: ReturnType<typeof setTimeout> | null; coldStartDone: boolean; }` -- remove `proxyLost` field entirely since there's no proxy_lost timer anymore.

**handleWsStatusChange rewrite:**

```
connected=true:
  1. dispatch SET_CONNECTED true
  2. relay.register()
  3. If phase is "connecting":
     - transition to "registering" (NOT proxy_selecting -- wait for register_response)
  4. If phase is "reconnecting":
     - relay.listProxies()
     - if selectedProxyId exists, relay.selectProxy(selectedProxyId)
     - clear reconnect timer
  5. Clear reconnect timer if exists

connected=false:
  1. dispatch SET_CONNECTED false
  2. dispatch SET_PROXY_ONLINE false
  3. If phase is NOT "connecting":
     - transition to "reconnecting"
     - set 10s timer: on timeout, transition to "connecting", reLaunch proxy-select
```

**handleRelayMessage rewrite:**

Handle `client_register_response`:
```
if msg.type === "client_register_response":
  if phase === "registering":
    relay.listProxies()
    transition to "proxy_selecting"
  (otherwise ignore -- reconnect flow handles separately)
```

Handle `proxy_offline` (NO proxy_lost, NO timer, NO page navigation):
```
if msg.type === "proxy_offline" && msg.proxyId === selectedProxyId:
  dispatch SET_PROXY_ONLINE false
  nav.showToast("Proxy offline")
  // That's it. No phase change. No timer. No reLaunch.
```

Handle `proxy_online`:
```
if msg.type === "proxy_online" && msg.proxyId === selectedProxyId:
  dispatch SET_PROXY_ONLINE true
  nav.showToast("Proxy reconnected")
  // No proxy_lost timer to cancel -- there is none.
```

Handle `proxy_list_response`:
```
if msg.type === "proxy_list_response":
  const proxies = msg.proxies

  // Cold start: first proxy_list_response in proxy_selecting
  if (!timers.coldStartDone && phase === "proxy_selecting"):
    timers.coldStartDone = true
    const savedProxyId = nav.getStorageSync("cc_proxyId")
    if (savedProxyId):
      // Use ensureBinding instead of resolveColdStart
      const result = await ensureBinding(relay as compatible, { proxyId: savedProxyId })
      if (!isBindingError(result)):
        dispatch SET_PROXY proxyId=savedProxyId, proxyName from proxies
        dispatch SET_PROXY_ONLINE true
        const savedSessionId = nav.getStorageSync("cc_sessionId")
        if (savedSessionId):
          const mode = nav.getStorageSync("cc_sessionMode") || "json"
          dispatch SET_PHASE "chatting"
          nav.navigateTo(`/pages/chat/index?sessionId=${savedSessionId}&mode=${mode}`)
        else:
          dispatch SET_PHASE "session_browsing"
          nav.navigateTo("/pages/session-list/index")
        return

  // Reconnect validation
  if (selectedProxyId):
    const selected = proxies.find(p => p.proxyId === selectedProxyId)
    dispatch SET_PROXY_ONLINE (selected?.online ?? false)
    if (phase === "reconnecting"):
      if (selected?.online):
        transitionToPhase to phaseBeforeDisconnect ?? "session_browsing"
      else:
        transitionToPhase to "proxy_selecting"
        nav.reLaunch("/pages/proxy-select/index")
```

Note: `handleRelayMessage` must become `async` since ensureBinding is async. Update the signature accordingly. The caller in app.tsx calls it with `void` prefix already (it's in a relay.onMessage callback), so making it async is safe.

**proxy-select/index.tsx changes:**

Remove the `useDidShow` block (lines 92-97) that corrects phase. Pages must not SET_PHASE.

Also in `handleSelect`: the line `Taro.setStorageSync("cc_proxyId", proxy.proxyId)` should be removed -- Storage write happens inside ensureBinding's selectProxy ACK path. The ensureBinding call already handles this via relay.selectProxy which sets boundProxyId on success. BUT -- looking at the code more carefully, ensureBinding doesn't write to Storage. The proxy-select page currently writes cc_proxyId before ensureBinding. Per design: "cc_proxyId written only after proxy_select_response success." So move the `Taro.setStorageSync("cc_proxyId", proxy.proxyId)` to AFTER the ensureBinding call succeeds (after the `if (isBindingError(result))` check), right before transitionToPhase.

**session-list/index.tsx changes:**

Remove the `useDidShow` block (lines 189-193) that corrects phase. Pages must not SET_PHASE.

**cold-start.ts:**

Delete the file. All cold start logic is now inline in phase-machine.ts handleRelayMessage.
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && npx tsc --noEmit -p apps/feishu/tsconfig.json 2>&1 | head -30</automated>
  </verify>
  <done>
    - AppPhase has "registering", no "proxy_lost"
    - phase-machine.ts uses ensureBinding for cold start, no resolveColdStart import
    - proxy_offline handler only sets proxyOnline=false + toast, no phase change or timer
    - proxy_online handler only sets proxyOnline=true + toast
    - client_register_response transitions registering -> proxy_selecting
    - useDidShow phase corrections removed from both pages
    - cold-start.ts deleted
    - cc_proxyId Storage write in proxy-select happens only after ensureBinding success
    - TypeScript compiles without errors
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Rewrite tests for new state machine</name>
  <files>
    apps/feishu/src/__tests__/phase-machine.test.ts
    apps/feishu/src/__tests__/app-store.test.ts
    apps/feishu/src/__tests__/cold-start.test.ts
  </files>
  <behavior>
    phase-machine.test.ts -- rewrite all test groups:

    handleWsStatusChange:
    - ws connect from connecting: transitions to "registering" (not proxy_selecting), calls register(), does NOT call listProxies yet
    - ws connect from reconnecting: clears reconnect timer, calls register + listProxies + selectProxy(selectedProxyId)
    - ws disconnect from chatting: sets proxyOnline=false, enters reconnecting, 10s timer
    - ws disconnect from connecting: no reconnecting phase
    - reconnect timeout 10s: transitions to connecting, reLaunch proxy-select
    - ws reconnect before 10s: cancels timer

    handleRelayMessage -- client_register_response:
    - from registering phase: calls listProxies, transitions to proxy_selecting
    - from non-registering phase: ignored (no phase change)

    handleRelayMessage -- proxy_offline/online:
    - proxy_offline for selected proxy: sets proxyOnline=false, shows toast, phase UNCHANGED (stays chatting)
    - proxy_offline for different proxy: no action
    - proxy_online for selected proxy: sets proxyOnline=true, shows toast, phase UNCHANGED
    - proxy_offline then online: proxyOnline toggles, phase never changes (no proxy_lost)

    handleRelayMessage -- proxy_list_response cold start:
    - cold start with saved proxyId: calls ensureBinding, on success transitions to session_browsing
    - cold start with saved proxyId + sessionId: calls ensureBinding, on success transitions to chatting with navigateTo chat URL
    - cold start fires only once
    - cold start skipped when no saved proxyId
    - cold start ensureBinding failure: stays in proxy_selecting, no navigation

    handleRelayMessage -- reconnect validation:
    - reconnecting + proxy online: restores phaseBeforeDisconnect
    - reconnecting + proxy offline: falls back to proxy_selecting + reLaunch
    - reconnecting + proxy not in list: falls back to proxy_selecting + reLaunch

    app-store.test.ts:
    - Remove the test "records phaseBeforeDisconnect when entering proxy_lost"
    - Remove the test "clears sessionId when transitioning from proxy_lost to session_browsing"
    - Add test: "records phaseBeforeDisconnect only when entering reconnecting"
    - Verify registering is accepted as a valid phase

    cold-start.test.ts:
    - Delete entirely (file is deleted in Task 1)
  </behavior>
  <action>
**phase-machine.test.ts:**

Update `createTestEnv`:
- Timers type no longer has `proxyLost`, only `{ reconnect, coldStartDone }`
- PhaseRelay mock needs `requestProxyList` and `getBoundProxyId` methods for ensureBinding compatibility
- Since handleRelayMessage is now async, tests calling it need to `await` the result

For the cold start tests: `ensureBinding` is called internally by handleRelayMessage. The mock relay.selectProxy already returns `Promise.resolve({ success: true, proxyId: "p1" })`. ensureBinding internally calls relay.selectProxy, so the mock needs to handle that. Since ensureBinding is imported by phase-machine, and phase-machine is what we're testing, we should NOT mock ensureBinding itself -- we test the production wiring. The relay mock's selectProxy returning success is sufficient. BUT ensureBinding also calls `relay.getBoundProxyId()` to check if already bound, so the mock needs that. Set it to return null by default (not bound).

For the ensureBinding path in cold start: ensureBinding receives the relay (cast to RelayClient-compatible). The PhaseRelay mock must satisfy the ensureBinding interface. Key methods used by ensureBinding: `getBoundProxyId()`, `requestProxyList()`, `selectProxy()`. The mock relay already has `selectProxy`. Add `getBoundProxyId: vi.fn(() => null)` and `requestProxyList` (not called in proxyId-only path).

**Important**: Since handleRelayMessage is now async, the proxy_list_response cold start path with ensureBinding is async. Tests must await. Use `await handleRelayMessage(...)` for proxy_list_response tests. Other message types (proxy_offline, proxy_online, client_register_response) can also be awaited harmlessly.

**app-store.test.ts:**

- Remove proxy_lost related tests
- Add test for "registering" phase being valid
- Verify phaseBeforeDisconnect is only set on "reconnecting" transition

**cold-start.test.ts:**

Delete the file entirely since cold-start.ts is deleted.
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter feishu run test 2>&1 | tail -30</automated>
  </verify>
  <done>
    - All phase-machine tests pass covering: registering transition, proxy offline/online without proxy_lost, cold start via ensureBinding, reconnect validation
    - app-store tests pass with no proxy_lost references
    - cold-start.test.ts deleted
    - No test uses resolveColdStart or references proxy_lost
    - Tests verify production wiring (ensureBinding called through relay mock, not mocked out)
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| relay->client WS | Messages from relay server to client |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation |
|-----------|----------|-----------|-------------|------------|
| T-quick-01 | S | phase-machine client_register_response | accept | Internal refactor, same trust model as before. Relay is trusted relay. |
</threat_model>

<verification>
1. `npx tsc --noEmit -p apps/feishu/tsconfig.json` passes
2. `pnpm --filter feishu run test` all tests pass
3. grep confirms zero occurrences of "proxy_lost" in apps/feishu/src/
4. grep confirms zero occurrences of "resolveColdStart" in apps/feishu/src/
5. grep confirms zero occurrences of "useDidShow.*SET_PHASE" in pages/
</verification>

<success_criteria>
- AppPhase = connecting | registering | reconnecting | proxy_selecting | session_browsing | chatting
- proxy offline: only proxyOnline flag changes + toast, no page jump
- cold start: uses ensureBinding, no separate cold-start.ts module
- pages are pure readers of phase, never writers
- all tests pass
</success_criteria>

<output>
After completion, create `.planning/quick/260413-mma-state-machine-refactor-step-4-client-exp/260413-mma-SUMMARY.md`
</output>
