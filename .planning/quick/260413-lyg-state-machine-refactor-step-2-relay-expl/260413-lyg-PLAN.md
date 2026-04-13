---
phase: quick
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/relay/src/registry.ts
  - apps/relay/src/handlers/proxy.ts
  - apps/relay/src/handlers/client.ts
  - apps/relay/src/health.ts
  - apps/relay/src/__tests__/unit/registry.test.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "Proxy connection state is an explicit enum, not derived from ws null checks"
    - "Client connection state is an explicit enum tracking registered vs bound"
    - "Illegal state transitions are rejected with errors"
    - "proxy_offline notification is sent from a single function, no duplication"
    - "All 155 existing tests continue to pass"
    - "Health API responses include explicit state field"
  artifacts:
    - path: "apps/relay/src/registry.ts"
      provides: "ProxyConnectionState and ClientConnectionState enums, transition functions"
      contains: "ProxyConnectionState"
    - path: "apps/relay/src/handlers/proxy.ts"
      provides: "Deduplicated proxy offline/online notification helpers"
      contains: "notifyClientsProxyOffline"
    - path: "apps/relay/src/__tests__/unit/registry.test.ts"
      provides: "State transition tests covering valid and invalid transitions"
      contains: "transitionProxy"
  key_links:
    - from: "apps/relay/src/handlers/proxy.ts"
      to: "apps/relay/src/registry.ts"
      via: "transitionProxy calls"
      pattern: "transitionProxy"
    - from: "apps/relay/src/handlers/client.ts"
      to: "apps/relay/src/registry.ts"
      via: "transitionClient calls"
      pattern: "transitionClient"
---

<objective>
Add explicit state machine enums to the relay registry for proxy and client connections.

Purpose: Replace implicit state derivation (ws null checks scattered everywhere) with explicit
ProxyConnectionState and ClientConnectionState enums. Add transition functions that validate
and log state changes, rejecting illegal transitions. Deduplicate the proxy_offline notification
that currently exists in both proxy.ts close handler and proxy_disconnect message handler.

Output: Refactored registry with explicit state enums, transition functions, deduplicated
notification helpers, and comprehensive tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@apps/relay/src/registry.ts
@apps/relay/src/handlers/proxy.ts
@apps/relay/src/handlers/client.ts
@apps/relay/src/health.ts
@apps/relay/src/__tests__/unit/registry.test.ts
@.planning/notes/2026-04-13-state-machine-design.md (section "三、Relay 状态机")

<interfaces>
<!-- Current ProxyState and ClientBinding interfaces from registry.ts -->
```typescript
// Current implicit state
interface ProxyState {
  ws: WebSocket | null;
  sessions: Set<string>;
  disconnectedAt: number | null;
  name?: string;
}

interface ClientBinding {
  proxyId: string;
  ws: WebSocket | null;
}
```

<!-- Key methods that do ws null checks (to be replaced with state enum checks) -->
```typescript
isProxyOnline(proxyId: string): boolean  // checks ws !== null && readyState === OPEN
listProxiesWithName(): Array<{ proxyId: string; name?: string; online: boolean }>  // same check inline
getProxyDetail(proxyId: string): { ...; online: boolean }  // same check inline
getClientDetails(): Array<{ clientId: string; proxyId: string; online: boolean }>  // same check inline
getClientsForProxy(proxyId: string): WebSocket[]  // checks ws && readyState === OPEN
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add explicit state enums and transition functions to registry</name>
  <files>
    apps/relay/src/registry.ts
    apps/relay/src/health.ts
    apps/relay/src/__tests__/unit/registry.test.ts
  </files>
  <behavior>
    - transitionProxy("p1", "online", "offline") succeeds when proxy is currently "online"
    - transitionProxy("p1", "offline", "online") succeeds when proxy is currently "offline"
    - transitionProxy("p1", "online", "online") throws (same state, no-op transition)
    - transitionProxy("p1", "offline", "offline") throws (same state)
    - transitionProxy("unknown", "online", "offline") throws (proxy not found)
    - transitionProxy("p1", "offline", "online") throws when proxy is actually "online" (from mismatch)
    - transitionClient("c1", "registered", "bound") succeeds when client is "registered"
    - transitionClient("c1", "bound", "registered") succeeds (re-select / unbind scenario)
    - transitionClient("c1", "registered", "registered") throws (same state)
    - transitionClient("unknown", "registered", "bound") throws (client not found)
    - getProxyConnectionState("p1") returns "online" after registration
    - getProxyConnectionState("p1") returns "offline" after markProxyOffline
    - getClientConnectionState("c1") returns "registered" is NOT a separate state; client starts at binding time
    - isProxyOnline still returns correct boolean but internally reads from connectionState
    - listProxiesWithName online field derives from connectionState, not ws null check
    - getProxyDetail includes connectionState field alongside online boolean
    - getClientDetails includes connectionState field alongside online boolean
    - All 155 existing tests continue to pass without modification
  </behavior>
  <action>
    1. Add exported type literals to registry.ts:
       ```typescript
       export type ProxyConnectionState = "online" | "offline";
       export type ClientConnectionState = "registered" | "bound";
       ```

    2. Update ProxyState interface to add `connectionState: ProxyConnectionState`:
       ```typescript
       interface ProxyState {
         ws: WebSocket | null;
         connectionState: ProxyConnectionState;
         sessions: Set<string>;
         disconnectedAt: number | null;
         name?: string;
       }
       ```

    3. Update ClientBinding interface to add `connectionState: ClientConnectionState`:
       ```typescript
       interface ClientBinding {
         proxyId: string;
         ws: WebSocket | null;
         connectionState: ClientConnectionState;
       }
       ```

    4. Add `transitionProxy(proxyId, from, to)` method to RelayRegistry:
       - Get proxy state, throw if not found
       - Throw if `state.connectionState !== from` (unexpected current state)
       - Throw if `from === to` (no-op)
       - Set `state.connectionState = to`
       - If transitioning to "offline": set `state.ws = null`, `state.disconnectedAt = Date.now()`
       - Log transition (optional, registry has no logger -- just do the validation)
       - Return void

    5. Add `transitionClient(clientId, from, to)` method to RelayRegistry:
       - Get binding, throw if not found
       - Throw if `binding.connectionState !== from`
       - Throw if `from === to`
       - Set `binding.connectionState = to`

    6. Add getter methods:
       - `getProxyConnectionState(proxyId): ProxyConnectionState | undefined`
       - `getClientConnectionState(clientId): ClientConnectionState | undefined`

    7. Update `registerProxy()`:
       - New proxy: set `connectionState: "online"`
       - Reconnected proxy: set `connectionState: "online"` (was implicitly set by ws assignment)

    8. Update `markProxyOffline()`:
       - Set `state.connectionState = "offline"` alongside `state.ws = null`

    9. Update `isProxyOnline()`:
       - Replace `state?.ws !== null && ... readyState === OPEN` with `state?.connectionState === "online"`
       - Keep ws readyState check as secondary guard: if connectionState says online but ws is dead, log warning and return false

    10. Update `listProxiesWithName()`:
        - Replace inline ws null check with `state.connectionState === "online"`

    11. Update `getProxyDetail()`:
        - Replace inline ws null check with `state.connectionState === "online"`
        - Add `connectionState: state.connectionState` to returned object

    12. Update `getClientDetails()`:
        - Replace inline ws null check with `binding.connectionState === "bound" && binding.ws !== null && binding.ws.readyState === WebSocket.OPEN`
        - Actually, `online` here means ws is connected. Keep ws check for `online` field, but add `connectionState: binding.connectionState` as new field

    13. Update `bindClientById()`:
        - Set `connectionState: "bound"` when creating new binding
        - If client already has a binding (re-select), update `connectionState` to "bound"

    14. Update `unbindClientById()`:
        - Set `binding.ws = null` but keep `connectionState` unchanged (still "bound", just disconnected)

    15. Update health.ts: No changes needed if getProxyDetail/getClientDetails already expose state.

    16. Add new test group "state transitions" to registry.test.ts:
        - Test all valid proxy transitions (online->offline, offline->online via registerProxy)
        - Test all invalid proxy transitions (same state, wrong from state, unknown proxy)
        - Test all valid client transitions (registered->bound, bound->registered)
        - Test all invalid client transitions
        - Test getProxyConnectionState and getClientConnectionState return values
        - Test that connectionState appears in getProxyDetail response
        - Test that connectionState appears in getClientDetails response
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter relay run test --run</automated>
  </verify>
  <done>
    - ProxyConnectionState ("online" | "offline") and ClientConnectionState ("registered" | "bound") exported from registry.ts
    - transitionProxy and transitionClient validate from-state before accepting transition
    - All isProxyOnline / listProxiesWithName / getProxyDetail / getClientDetails use connectionState
    - New state transition tests pass
    - All 155 existing tests pass unchanged
  </done>
</task>

<task type="auto">
  <name>Task 2: Deduplicate proxy notifications and wire handlers to transitions</name>
  <files>
    apps/relay/src/handlers/proxy.ts
    apps/relay/src/handlers/client.ts
  </files>
  <action>
    1. Extract `notifyClientsProxyOffline(proxyId, registry, logger)` in proxy.ts:
       ```typescript
       function notifyClientsProxyOffline(proxyId: string, registry: RelayRegistry, logger: Logger): void {
         const clients = registry.getClientsForProxy(proxyId);
         for (const clientWs of clients) {
           clientWs.send(JSON.stringify({ type: "proxy_offline", proxyId }));
         }
         logger.info({ proxyId, clientCount: clients.length }, "Notified clients of proxy offline");
       }
       ```

    2. Extract `notifyClientsProxyOnline(proxyId, registry, logger)` in proxy.ts:
       ```typescript
       function notifyClientsProxyOnline(proxyId: string, registry: RelayRegistry, logger: Logger): void {
         const clients = registry.getClientsForProxy(proxyId);
         for (const clientWs of clients) {
           clientWs.send(JSON.stringify({ type: "proxy_online", proxyId }));
         }
         logger.info({ proxyId, clientCount: clients.length }, "Notified clients of proxy online");
       }
       ```

    3. Update `proxy_register` handler:
       - After `registerProxy()` returns "reconnected", call `notifyClientsProxyOnline()` instead of inline loop
       - Remove the inline notification loop

    4. Update `proxy_disconnect` handler:
       - Call `notifyClientsProxyOffline()` BEFORE `unregisterProxy()` (need active bindings to find clients)
       - Remove inline notification loop

    5. Update `close` event handler:
       - Call `notifyClientsProxyOffline()` BEFORE `markProxyOffline()`
       - Replace `markProxyOffline()` with `transitionProxy(proxyId, "online", "offline")` wrapped in try/catch
       - If transition throws (proxy already offline from proxy_disconnect), silently skip
       - Remove inline notification loop

    6. Update client.ts `proxy_select` handler:
       - After successful `bindClientById()`, call `registry.transitionClient(clientId, "registered", "bound")`
       - But only if the client was previously "registered". For re-bind (already "bound"), skip transition or use try/catch.
       - Simpler approach: check `getClientConnectionState(clientId)` before calling transition. If already "bound", no transition needed (re-select same proxy or switching proxy).

    7. Update client.ts `client_register` handler (handleClientRegister function):
       - When binding exists and is restored, the client's connectionState is already "bound" from before disconnect.
       - The ws gets updated via `updateClientSocket()`. No state transition needed since binding was preserved.

    8. Update client.ts `close` event handler:
       - `unbindClientById()` already preserves connectionState. No changes needed.

    Key principle: proxy.ts close handler and proxy_disconnect handler MUST NOT both independently notify clients. The notification helper is the single source.
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter relay run test --run</automated>
  </verify>
  <done>
    - notifyClientsProxyOffline is a single function called from both close event and proxy_disconnect handler
    - notifyClientsProxyOnline is a single function called from reconnect path
    - proxy.ts close handler uses transitionProxy instead of markProxyOffline
    - No duplicated inline notification loops remain in proxy.ts
    - All 155+ tests pass
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

No new trust boundaries introduced. This is an internal refactor of relay state management.
All existing boundaries (proxy->relay, client->relay) remain unchanged.

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation |
|-----------|----------|-----------|-------------|------------|
| T-quick-01 | T (Tampering) | transitionProxy | accept | Internal-only function, not exposed to protocol messages. Callers are already authenticated handlers. |
| T-quick-02 | D (DoS) | transition throw | mitigate | Transition errors caught in handlers, logged as warnings, do not crash relay process |
</threat_model>

<verification>
1. `pnpm --filter relay run test --run` -- all tests pass (155 existing + new state transition tests)
2. Grep for `state.ws !== null && state.ws !== undefined && state.ws.readyState` in registry.ts -- zero occurrences (replaced by connectionState checks)
3. Grep for `proxy_offline` send in proxy.ts -- appears only inside `notifyClientsProxyOffline`, not inline
4. `ProxyConnectionState` and `ClientConnectionState` are exported from registry.ts
</verification>

<success_criteria>
- Explicit ProxyConnectionState and ClientConnectionState enums replace implicit ws null checks
- transitionProxy and transitionClient reject illegal transitions with thrown errors
- Single notifyClientsProxyOffline function eliminates duplicated notification code
- All existing 155 tests pass, new state transition tests added
- Health API responses include connectionState field
</success_criteria>

<output>
After completion, create `.planning/quick/260413-lyg-state-machine-refactor-step-2-relay-expl/260413-lyg-SUMMARY.md`
</output>
