---
phase: quick-260413-lbi
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/shared/src/schemas/relay-control.ts
  - packages/shared/src/index.ts
  - apps/relay/src/handlers/client.ts
  - apps/relay/src/handlers/proxy.ts
  - apps/relay/src/registry.ts
  - apps/feishu/src/services/relay-client.ts
  - apps/feishu/src/services/ensure-binding.ts
  - apps/feishu/src/pages/chat/index.tsx
  - apps/feishu/src/phase-machine.ts
  - apps/feishu/src/pages/proxy-select/index.tsx
  - packages/shared/src/schemas/__tests__/relay-control.test.ts
  - apps/relay/src/__tests__/integration/client-register.test.ts
  - apps/relay/src/__tests__/integration/server.test.ts
  - apps/feishu/src/__tests__/relay-client.test.ts
  - apps/feishu/src/__tests__/phase-machine.test.ts
  - apps/feishu/src/__tests__/ensure-binding.test.ts
autonomous: true
must_haves:
  truths:
    - "proxy_select now receives a proxy_select_response ACK from relay"
    - "proxy_list_response includes sessions per proxy"
    - "bind_by_session and bind_by_session_response no longer exist in schema or handlers"
    - "All binding scenarios (user select, cold start, URL sessionId, reconnect) use ensureBinding"
    - "ensureBinding resolves sessionId to proxyId via proxy_list_response locally"
  artifacts:
    - path: "packages/shared/src/schemas/relay-control.ts"
      provides: "proxy_select_response schema, ProxyInfo.sessions, no bind_by_session"
      contains: "proxy_select_response"
    - path: "apps/feishu/src/services/ensure-binding.ts"
      provides: "Unified binding function for all 4 scenarios"
      exports: ["ensureBinding"]
    - path: "apps/relay/src/handlers/client.ts"
      provides: "proxy_select_response ACK, no bind_by_session handler"
    - path: "apps/feishu/src/__tests__/ensure-binding.test.ts"
      provides: "Tests for all 4 binding scenarios"
  key_links:
    - from: "apps/relay/src/handlers/client.ts"
      to: "proxy_select_response"
      via: "send ACK after proxy_select"
      pattern: "proxy_select_response"
    - from: "apps/feishu/src/services/ensure-binding.ts"
      to: "relay-client.ts selectProxy"
      via: "async selectProxy returns Promise"
      pattern: "selectProxy"
    - from: "apps/relay/src/handlers/proxy.ts"
      to: "registry.getSessionsForProxy"
      via: "broadcastProxyList includes sessions"
      pattern: "sessions"
---

<objective>
State machine refactor Step 1: Unify binding protocol and remove bind_by_session.

Purpose: Simplify the binding protocol to a single path (proxy_select with ACK), move sessionId-to-proxyId resolution to the client side via proxy_list_response (which now includes sessions per proxy), and consolidate all 4 binding scenarios into a single ensureBinding function.

Output: Protocol changes in shared, relay handler updates, client ensureBinding module, updated tests.
</objective>

<execution_context>
@.planning/notes/2026-04-13-state-machine-design.md
</execution_context>

<context>
@packages/shared/src/schemas/relay-control.ts
@apps/relay/src/handlers/client.ts
@apps/relay/src/handlers/proxy.ts
@apps/relay/src/registry.ts
@apps/feishu/src/services/relay-client.ts
@apps/feishu/src/pages/chat/index.tsx
@apps/feishu/src/phase-machine.ts
@apps/feishu/src/pages/proxy-select/index.tsx
@apps/feishu/src/pages/proxy-select/cold-start.ts
@apps/feishu/src/stores/app-store.ts

<interfaces>
From packages/shared/src/schemas/relay-control.ts:
```typescript
export const ProxyInfoSchema = z.object({ proxyId: z.string(), name: z.string().optional(), online: z.boolean() });
export type ProxyInfo = z.infer<typeof ProxyInfoSchema>;
export const RelayControlSchema = z.discriminatedUnion("type", [...]);
export type RelayControlMessage = z.infer<typeof RelayControlSchema>;
```

From apps/relay/src/registry.ts:
```typescript
export class RelayRegistry {
  registerProxy(proxyId: string, ws: WebSocket, name?: string): "new" | "reconnected";
  isProxyOnline(proxyId: string): boolean;
  bindClientById(clientId: string, proxyId: string, ws: WebSocket): boolean;
  getSessionsForProxy(proxyId: string): string[];
  getProxyForSession(sessionId: string): string | undefined;
  listProxiesWithName(): Array<{ proxyId: string; name?: string; online: boolean }>;
}
```

From apps/feishu/src/services/relay-client.ts:
```typescript
export class RelayClient {
  register(): void;
  listProxies(): void;
  selectProxy(proxyId: string): void;
  bindBySession(sessionId: string): void;
  sendEnvelope(envelope: MessageEnvelope): void;
  sendControl(msg: RelayControlMessage): void;
  getBoundProxyId(): string | null;
  onMessage(handler: (msg: MessageEnvelope | RelayControlMessage) => void): () => void;
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Protocol schema changes + Relay handler updates + Relay/shared tests</name>
  <files>
    packages/shared/src/schemas/relay-control.ts
    packages/shared/src/index.ts
    apps/relay/src/handlers/client.ts
    apps/relay/src/handlers/proxy.ts
    apps/relay/src/registry.ts
    packages/shared/src/schemas/__tests__/relay-control.test.ts
    apps/relay/src/__tests__/integration/client-register.test.ts
    apps/relay/src/__tests__/integration/server.test.ts
  </files>
  <action>
**Schema changes in `packages/shared/src/schemas/relay-control.ts`:**

1. Add `sessions: z.array(z.string()).optional()` to `ProxyInfoSchema`:
   ```typescript
   export const ProxyInfoSchema = z.object({
     proxyId: z.string(),
     name: z.string().optional(),
     online: z.boolean(),
     sessions: z.array(z.string()).optional(),
   });
   ```

2. Add `proxy_select_response` to `RelayControlSchema` discriminated union:
   ```typescript
   z.object({
     type: z.literal("proxy_select_response"),
     success: z.boolean(),
     proxyId: z.string().optional(),
     error: z.string().optional(),
   }),
   ```

3. Remove `bind_by_session` and `bind_by_session_response` entries (the two z.object blocks with those type literals).

**Relay handler changes in `apps/relay/src/handlers/client.ts`:**

4. In `proxy_select` handler: replace the current relay_error responses with `proxy_select_response`. When proxy is not online or not found, send `{ type: "proxy_select_response", success: false, error: "..." }`. When bind succeeds, send `{ type: "proxy_select_response", success: true, proxyId: msg.proxyId }` after the `registry.bindClientById` call.

5. Remove the entire `if (msg.type === "bind_by_session")` block (lines 129-151 in current file).

**Relay handler changes in `apps/relay/src/handlers/proxy.ts`:**

6. Modify `broadcastProxyList` to include sessions per proxy. Change `listProxiesWithName()` call to also fetch sessions:
   ```typescript
   function broadcastProxyList(registry: RelayRegistry): void {
     const proxies = registry.listProxiesWithName().map(p => ({
       ...p,
       sessions: registry.getSessionsForProxy(p.proxyId),
     }));
     const msg = JSON.stringify({ type: "proxy_list_response", proxies });
     for (const clientWs of registry.getAllClientWs()) {
       clientWs.send(msg);
     }
   }
   ```

7. Similarly, in `apps/relay/src/handlers/client.ts`, the `proxy_list_request` handler should also include sessions:
   ```typescript
   if (msg.type === "proxy_list_request") {
     const proxies = registry.listProxiesWithName().map(p => ({
       ...p,
       sessions: registry.getSessionsForProxy(p.proxyId),
     }));
     clientWs.send(JSON.stringify({ type: "proxy_list_response", proxies }));
     return;
   }
   ```

8. In `apps/relay/src/registry.ts`: keep `getProxyForSession` -- it's still used by the health endpoint. No changes needed to registry.

**Shared index.ts:** No new exports needed (ProxyInfo type already exported, proxy_select_response is part of RelayControlMessage union).

**Test updates:**

9. `packages/shared/src/schemas/__tests__/relay-control.test.ts`:
   - Add test: `proxy_select_response` parses with success=true, proxyId
   - Add test: `proxy_select_response` parses with success=false, error
   - Add test: `proxy_list_response` parses with `sessions` field in ProxyInfo
   - Add test: `bind_by_session` type is rejected (no longer in schema)
   - Add test: `bind_by_session_response` type is rejected

10. `apps/relay/src/__tests__/integration/client-register.test.ts`:
    - Update `proxy_select rejects binding to offline proxy` test: expect `proxy_select_response` with `success: false` instead of `relay_error`
    - Update `proxy_select rejects binding to nonexistent proxy` test: expect `proxy_select_response` with `success: false` instead of `relay_error`
    - Add new test: `proxy_select returns proxy_select_response with success true` -- register proxy, client sends proxy_select, expect `{ type: "proxy_select_response", success: true, proxyId: "p1" }`
    - Add new test: `proxy_list_response includes sessions per proxy` -- register proxy, have proxy send session_sync with sessions, client requests proxy_list, verify response proxies include sessions array
    - Update `proxy_select still works for clients without client_register` test: after proxy_select, first message should be `proxy_select_response`, then consume it before testing envelope forwarding

11. `apps/relay/src/__tests__/integration/server.test.ts`:
    - Update `client sends proxy_list_request and receives response` test: expect proxies to include `sessions: []` (empty array since no sessions registered)
    - Update `client gets error when selecting non-existent proxy` test: expect `proxy_select_response` with `success: false` instead of `relay_error`
    - Update `client selects proxy and messages route bidirectionally` test: consume the `proxy_select_response` ACK before testing envelope forwarding. After `proxy_select`, do `waitForMessage(client)` to consume the ACK, then proceed with the proxy->client envelope test.
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter shared run test -- --run && pnpm --filter relay run test -- --run</automated>
  </verify>
  <done>
    - proxy_select_response exists in schema and relay sends it on proxy_select
    - bind_by_session / bind_by_session_response removed from schema and relay handler
    - proxy_list_response includes sessions per proxy
    - All shared and relay tests pass
  </done>
</task>

<task type="auto">
  <name>Task 2: Client binding unification (ensureBinding + relay-client + pages + tests)</name>
  <files>
    apps/feishu/src/services/relay-client.ts
    apps/feishu/src/services/ensure-binding.ts
    apps/feishu/src/pages/chat/index.tsx
    apps/feishu/src/phase-machine.ts
    apps/feishu/src/pages/proxy-select/index.tsx
    apps/feishu/src/__tests__/relay-client.test.ts
    apps/feishu/src/__tests__/phase-machine.test.ts
    apps/feishu/src/__tests__/ensure-binding.test.ts
  </files>
  <action>
**RelayClient changes in `apps/feishu/src/services/relay-client.ts`:**

1. Remove `bindBySession(sessionId: string)` method entirely.

2. Remove the `bind_by_session_response` handling in the constructor's `onMessage` callback (the block that checks for `bind_by_session_response` and updates `this.boundProxyId`).

3. Make `selectProxy` return a Promise that resolves with the `proxy_select_response` ACK:
   ```typescript
   selectProxy(proxyId: string): Promise<{ success: boolean; proxyId?: string; error?: string }> {
     return new Promise((resolve) => {
       const unsub = this.onMessage((msg) => {
         if ("type" in msg && (msg as Record<string, unknown>).type === "proxy_select_response") {
           unsub();
           const resp = msg as Record<string, unknown>;
           if (resp.success) {
             this.boundProxyId = proxyId;
           }
           resolve({
             success: resp.success as boolean,
             proxyId: resp.proxyId as string | undefined,
             error: resp.error as string | undefined,
           });
         }
       });
       this.ws.send(JSON.stringify({ type: "proxy_select", proxyId }));
     });
   }
   ```
   Note: `selectProxy` no longer eagerly sets `this.boundProxyId` -- it only sets it on success ACK.

4. Add a `waitForProxyList` helper method to RelayClient that requests proxy list and returns a Promise resolving with the response:
   ```typescript
   requestProxyList(): Promise<Array<{ proxyId: string; name?: string; online: boolean; sessions?: string[] }>> {
     return new Promise((resolve) => {
       const unsub = this.onMessage((msg) => {
         if ("type" in msg && (msg as Record<string, unknown>).type === "proxy_list_response") {
           unsub();
           resolve((msg as Record<string, unknown>).proxies as Array<{ proxyId: string; name?: string; online: boolean; sessions?: string[] }>);
         }
       });
       this.ws.send(JSON.stringify({ type: "proxy_list_request" }));
     });
   }
   ```
   Keep the existing `listProxies()` fire-and-forget method as well (it's used by phase-machine cold start path where response is handled via onMessage).

**Create `apps/feishu/src/services/ensure-binding.ts`:**

5. Implement the unified binding function per the design doc:
   ```typescript
   import type { RelayClient } from "./relay-client";

   export interface BindingContext {
     proxyId?: string;
     sessionId?: string;
   }

   export interface BindingSuccess {
     proxyId: string;
   }

   export interface BindingError {
     error: string;
   }

   export type BindingResult = BindingSuccess | BindingError;

   export function isBindingError(result: BindingResult): result is BindingError {
     return "error" in result;
   }

   // 统一绑定函数，4 个场景 1 条路径
   export async function ensureBinding(
     relay: RelayClient,
     context: BindingContext,
   ): Promise<BindingResult> {
     let targetProxyId = context.proxyId;

     // 已绑定且 proxyId 匹配，直接返回
     if (targetProxyId && relay.getBoundProxyId() === targetProxyId) {
       return { proxyId: targetProxyId };
     }

     // 只有 sessionId 没有 proxyId：通过 proxy_list 匹配
     if (!targetProxyId && context.sessionId) {
       const proxies = await relay.requestProxyList();
       const match = proxies.find(p =>
         p.sessions?.includes(context.sessionId!)
       );
       if (!match) {
         return { error: `Session ${context.sessionId} not found on any proxy` };
       }
       targetProxyId = match.proxyId;
     }

     if (!targetProxyId) {
       return { error: "No proxy specified" };
     }

     // 统一走 proxy_select
     const ack = await relay.selectProxy(targetProxyId);
     if (!ack.success) {
       return { error: ack.error || "Proxy select failed" };
     }
     return { proxyId: targetProxyId };
   }
   ```

**Chat page changes in `apps/feishu/src/pages/chat/index.tsx`:**

6. Replace the `bindBySession` + `bind_by_session_response` listener pattern (the useEffect around line 243-265) with `ensureBinding`:
   ```typescript
   import { ensureBinding, isBindingError } from "@/services/ensure-binding";
   
   useEffect(() => {
     if (!relay || !sessionId) return;
     let cancelled = false;

     async function bind() {
       if (!relay) return;
       const result = await ensureBinding(relay, {
         proxyId: appState.selectedProxyId || undefined,
         sessionId,
       });
       if (cancelled) return;
       if (isBindingError(result)) {
         console.error("[chat] binding failed:", result.error);
         return;
       }
       // 绑定成功后请求终端帧
       if (isPty) {
         relay.sendControl({ type: "terminal_frame_request", sessionId });
       }
     }

     // 已绑定时直接请求帧，否则走绑定流程
     if (relay.getBoundProxyId()) {
       if (isPty) {
         relay.sendControl({ type: "terminal_frame_request", sessionId });
       }
     } else {
       bind();
     }

     return () => { cancelled = true; };
   }, [relay, sessionId, isPty, appState.selectedProxyId]);
   ```

**Phase machine changes in `apps/feishu/src/phase-machine.ts`:**

7. In `handleWsStatusChange`, the reconnect path currently does `relay.selectProxy(s.selectedProxyId)` (fire-and-forget). Change this to NOT await -- it's still a reconnect hint, the real binding confirmation comes from `proxy_list_response` handling. But now `selectProxy` returns a Promise, so just call it without await and ignore the return value. The phase machine reconnect logic validates via proxy_list_response anyway, so this is fine. Use `void relay.selectProxy(...)` to explicitly discard the Promise.

8. In `handleRelayMessage` cold start path, `relay.selectProxy(result.proxy.proxyId)` is also called fire-and-forget. Same treatment: `void relay.selectProxy(...)`. The cold start path transitions phase immediately based on proxy_list_response, it doesn't wait for proxy_select_response. This is acceptable because the proxy is already confirmed online from the proxy_list.

**Proxy-select page changes in `apps/feishu/src/pages/proxy-select/index.tsx`:**

9. In `handleSelect`, replace the fire-and-forget `relay.selectProxy(proxy.proxyId)` with an async ensureBinding call. But careful: the page also dispatches state immediately. Keep the optimistic dispatch but use ensureBinding for the actual binding:
   ```typescript
   import { ensureBinding, isBindingError } from "@/services/ensure-binding";

   const handleSelect = useCallback(
     async (proxy: ProxyInfo) => {
       Taro.setStorageSync("cc_proxyId", proxy.proxyId);
       appDispatch({
         type: "SET_PROXY",
         proxyId: proxy.proxyId,
         proxyName: proxy.name || null,
       });
       appDispatch({ type: "SET_PROXY_ONLINE", online: true });
       if (relay) {
         const result = await ensureBinding(relay, { proxyId: proxy.proxyId });
         if (isBindingError(result)) {
           // 绑定失败时回退状态
           appDispatch({ type: "SET_PROXY_ONLINE", online: false });
           Taro.showToast({ title: result.error, icon: "none" });
           return;
         }
       }
       transitionToPhase(appState.phase, "session_browsing", appDispatch);
       Taro.navigateTo({ url: "/pages/session-list/index" });
     },
     [relay, appDispatch, appState.phase],
   );
   ```
   This means navigation now waits for the ACK. The phase transition and navigation happen only after successful binding.

**Test updates:**

10. `apps/feishu/src/__tests__/relay-client.test.ts`:
    - Update `selectProxy` test: it should now return a Promise. Simulate the `proxy_select_response` via wsRawHandler to resolve it. Test both success and failure cases.
    - Remove any test for `bindBySession` (no longer exists).
    - Add test for `requestProxyList` method.

11. `apps/feishu/src/__tests__/phase-machine.test.ts`:
    - Update PhaseRelay interface mock: `selectProxy` now returns a Promise. Change `selectProxy: vi.fn()` to `selectProxy: vi.fn(() => Promise.resolve({ success: true, proxyId: "p1" }))`.
    - Verify existing tests still pass with this change (the phase machine calls `void relay.selectProxy(...)` so it doesn't await).
    - No behavioral changes expected in the tests -- the phase machine doesn't depend on selectProxy return value.

12. Create `apps/feishu/src/__tests__/ensure-binding.test.ts`:
    Test all 4 binding scenarios:
    - **Already bound**: relay.getBoundProxyId() returns matching proxyId -> returns immediately without calling selectProxy
    - **User selection (proxyId given)**: calls selectProxy, receives ACK success -> returns proxyId
    - **URL sessionId only**: calls requestProxyList, matches session -> calls selectProxy -> returns proxyId
    - **URL sessionId not found**: calls requestProxyList, no match -> returns error
    - **selectProxy fails**: calls selectProxy, receives ACK with success=false -> returns error
    - **No proxy specified**: neither proxyId nor sessionId -> returns error

    Use a mock RelayClient with vi.fn() for getBoundProxyId, selectProxy, requestProxyList.
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere && pnpm --filter feishu run test -- --run</automated>
  </verify>
  <done>
    - bindBySession removed from RelayClient
    - selectProxy returns Promise resolving on proxy_select_response ACK
    - ensureBinding function handles all 4 scenarios
    - chat/index.tsx uses ensureBinding instead of bindBySession
    - phase-machine.ts uses void relay.selectProxy (Promise-returning but not awaited)
    - proxy-select page uses ensureBinding with error handling
    - All feishu tests pass including new ensure-binding tests
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| client->relay | Client sends proxy_select, relay validates proxy existence before ACK |
| proxy->relay | Proxy provides session lists, relay trusts but validates format via schema |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-quick-01 | Spoofing | proxy_select_response | mitigate | Relay only sends proxy_select_response in direct response to proxy_select from same ws connection; client correlates by message type on its single ws |
| T-quick-02 | Information Disclosure | proxy_list_response sessions | accept | Session IDs are opaque strings, already visible to authenticated clients; no PII exposure |
| T-quick-03 | Denial of Service | ensureBinding Promise | mitigate | ensureBinding callers handle cancelled flag / component unmount; Promise resolves on next message, no unbounded wait in production (ws disconnect triggers cleanup) |
</threat_model>

<verification>
1. `pnpm --filter shared run test -- --run` passes (schema tests)
2. `pnpm --filter relay run test -- --run` passes (integration tests with proxy_select_response ACK)
3. `pnpm --filter feishu run test -- --run` passes (relay-client, ensure-binding, phase-machine tests)
4. `pnpm run build` succeeds across all packages (TypeScript compilation)
</verification>

<success_criteria>
- bind_by_session and bind_by_session_response completely removed from codebase
- proxy_select produces proxy_select_response ACK in relay
- proxy_list_response includes sessions per proxy
- All binding in client goes through ensureBinding (4 scenarios, 1 function, 1 protocol path)
- No regressions: all existing tests updated and passing
</success_criteria>

<output>
After completion, create `.planning/quick/260413-lbi-state-machine-refactor-step-1-protocol-c/260413-lbi-SUMMARY.md`
</output>
