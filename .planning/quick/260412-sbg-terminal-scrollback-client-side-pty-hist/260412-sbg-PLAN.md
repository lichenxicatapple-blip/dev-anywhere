---
phase: quick
plan: 01
type: tdd
wave: 1
depends_on: []
files_modified:
  - apps/feishu/src/services/scrollback-cache.ts
  - apps/feishu/src/__tests__/scrollback-cache.test.ts
  - apps/feishu/src/stores/terminal-store.ts
  - apps/feishu/src/components/terminal-viewport/index.tsx
  - apps/feishu/src/components/terminal-viewport/index.css
  - apps/feishu/src/pages/chat/index.tsx
  - apps/feishu/e2e/terminal-scrollback.spec.ts
autonomous: false
requirements: []

must_haves:
  truths:
    - "User can scroll up in PTY terminal viewport to see history lines beyond current viewport"
    - "Scrolling to top triggers a terminal_lines_request to fetch older lines"
    - "Fetched history lines render above the current viewport seamlessly"
    - "User stops seeing a loading indicator when oldest available line is reached"
    - "New terminal_frame updates still auto-scroll to bottom when user is at bottom"
    - "When user is browsing scrollback, new frames do NOT yank scroll position"
  artifacts:
    - path: "apps/feishu/src/services/scrollback-cache.ts"
      provides: "ScrollbackCache class: lineId-indexed cache with miss detection, boundary tracking"
      exports: ["ScrollbackCache"]
    - path: "apps/feishu/src/__tests__/scrollback-cache.test.ts"
      provides: "Unit tests for ScrollbackCache (cache hit/miss, boundary, clear)"
    - path: "apps/feishu/e2e/terminal-scrollback.spec.ts"
      provides: "E2E test for scroll-to-load-history behavior"
  key_links:
    - from: "apps/feishu/src/components/terminal-viewport/index.tsx"
      to: "apps/feishu/src/services/scrollback-cache.ts"
      via: "ScrollbackCache instance stored in terminal-store state"
      pattern: "scrollbackCache\\.(getCachedLines|applyLinesResponse|getMissingRange)"
    - from: "apps/feishu/src/pages/chat/index.tsx"
      to: "relay.sendControl"
      via: "terminal_lines_request when scroll hits top and cache has uncached range"
      pattern: "sendControl.*terminal_lines_request"
    - from: "apps/feishu/src/pages/chat/index.tsx"
      to: "terminal-store"
      via: "APPLY_LINES_RESPONSE action routes terminal_lines_response to cache"
      pattern: "APPLY_LINES_RESPONSE"
---

<objective>
Add client-side PTY terminal scrollback: users can scroll up past the current viewport to load and view terminal history lines on demand.

Purpose: The PTY viewport currently only shows the live frame. Users cannot review past output — a critical gap for mobile usage where the terminal often scrolls faster than you can read.

Output: ScrollbackCache service, updated terminal-store with scrollback state, terminal-viewport with scroll-up-to-load UX, chat page wiring for terminal_lines_request/response.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@apps/feishu/src/components/terminal-viewport/index.tsx
@apps/feishu/src/components/terminal-viewport/index.css
@apps/feishu/src/stores/terminal-store.ts
@apps/feishu/src/pages/chat/index.tsx
@apps/feishu/src/services/relay-client.ts
@apps/proxy/src/terminal-frame-renderer.ts
@packages/shared/src/schemas/relay-control.ts
@packages/shared/src/schemas/session.ts

<interfaces>
<!-- Existing backend protocol contracts — executor must use these exactly. -->

From packages/shared/src/schemas/relay-control.ts:
```typescript
// Client -> Proxy: request history lines
z.object({
  type: z.literal("terminal_lines_request"),
  sessionId: z.string(),
  fromLineId: z.number().int(),
  count: z.number().int().positive(),
})

// Proxy -> Client: history lines response
z.object({
  type: z.literal("terminal_lines_response"),
  sessionId: z.string(),
  fromLineId: z.number().int(),
  oldestLineId: z.number().int(),
  newestLineId: z.number().int(),
  lines: z.array(z.array(TermSpanSchema)),
})
```

From packages/shared/src/schemas/session.ts:
```typescript
export type TermLine = TermSpan[];
export type TermSpan = z.infer<typeof TermSpanSchema>;
// TermSpan: { text, fg?, bg?, bold?, dim?, italic?, underline?, strikethrough? }
```

From apps/proxy/src/terminal-frame-renderer.ts (reference implementation for cache design):
```typescript
export class TerminalFrameRenderer {
  private scrollbackCache = new Map<number, TermLine>();
  private _oldestLineId = 0;
  private _newestLineId = 0;
  private _scrollPosition: number | null = null;

  applyLinesResponse(response: TerminalLinesResponse): void { ... }
  getCachedLines(fromLineId: number, count: number): Array<TermLine | null> { ... }
  getMissingRange(fromLineId: number, count: number): { fromLineId: number; count: number } | null { ... }
  clearCache(): void { ... }
}
```

From apps/feishu/src/services/relay-client.ts:
```typescript
sendControl(msg: RelayControlMessage): void;
onMessage(handler: (msg: MessageEnvelope | RelayControlMessage) => void): () => void;
```

From apps/feishu/src/stores/terminal-store.ts:
```typescript
export interface TerminalStoreState {
  lines: TermLine[];
  fontSize: number;
  fontSizeIndex: number;
  ptyState: "working" | "turn_complete" | "approval_wait" | "idle";
  ptyTitle: string | null;
  approvalTool: string | null;
}

export type TerminalAction =
  | { type: "SET_TERMINAL_LINES"; lines: TermLine[] }
  | { type: "SET_FONT_SIZE_INDEX"; index: number }
  | { type: "SET_PTY_STATE"; state: TerminalStoreState["ptyState"]; title?: string }
  | { type: "SET_APPROVAL_TOOL"; tool: string | null };
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: RED -- Write failing tests for ScrollbackCache and E2E scrollback</name>
  <files>
    apps/feishu/src/__tests__/scrollback-cache.test.ts
    apps/feishu/src/services/scrollback-cache.ts
    apps/feishu/e2e/terminal-scrollback.spec.ts
  </files>
  <behavior>
    ScrollbackCache unit tests (mirror proxy TerminalFrameRenderer cache behavior):
    - applyLinesResponse stores lines by lineId, updates oldestLineId/newestLineId bounds
    - getCachedLines returns TermLine for cached ids, null for uncached
    - getMissingRange returns null when fully cached, returns {fromLineId, count} for uncached ranges
    - clearCache resets cache to empty, scrollPosition to null
    - isAtOldest returns true when fromLineId <= oldestLineId (no more history available)
    - cacheSize tracks number of cached lines

    E2E test (Playwright, H5 mode):
    - Navigate to a PTY session chat page
    - Verify terminal-viewport renders with lines
    - Scroll the viewport to top
    - Verify a terminal_lines_request is sent (intercept WebSocket or check DOM for loading indicator)
    - When mock response arrives, verify additional lines render above the viewport
  </behavior>
  <action>
    1. Create `apps/feishu/src/services/scrollback-cache.ts` as an EMPTY stub that exports `ScrollbackCache` class with all methods throwing `new Error("not implemented")`. This makes the test file importable but all tests will fail (RED).

    The ScrollbackCache API must mirror the proxy's TerminalFrameRenderer cache methods exactly:
    - `applyLinesResponse(response: { fromLineId: number; oldestLineId: number; newestLineId: number; lines: TermLine[] }): void`
    - `getCachedLines(fromLineId: number, count: number): Array<TermLine | null>`
    - `getMissingRange(fromLineId: number, count: number): { fromLineId: number; count: number } | null`
    - `isAtOldest(fromLineId: number): boolean`
    - `clearCache(): void`
    - `get cacheSize(): number`
    - `get oldestLineId(): number`
    - `get newestLineId(): number`

    2. Create `apps/feishu/src/__tests__/scrollback-cache.test.ts` with unit tests covering:
    - Empty cache: getCachedLines returns all nulls, getMissingRange returns full range, cacheSize is 0
    - After applyLinesResponse: cached lines returned correctly, bounds updated
    - Partial cache hit: getMissingRange returns narrowed range
    - Full cache hit: getMissingRange returns null
    - isAtOldest: true when fromLineId <= oldestLineId
    - clearCache: resets everything
    - Multiple applyLinesResponse calls accumulate in cache

    3. Create `apps/feishu/e2e/terminal-scrollback.spec.ts` with E2E test:
    - This E2E test needs real relay+proxy running (same as existing E2E pattern in scroll-check.spec.ts).
    - Navigate to proxy-select, select proxy, select PTY session, wait for terminal-viewport to appear.
    - Verify `.terminal-viewport` exists and has `.terminal-line` children.
    - Record current line count.
    - Scroll the viewport to the very top using `page.evaluate` to set scrollTop = 0.
    - After scrolling to top, check for a loading indicator element (`.scrollback-loading`) or additional lines appearing.
    - The test should be marked with `test.skip` annotation with comment "Enable after Task 2 implements scrollback" since it requires full integration. The unit tests are the primary RED target.

    4. Run unit tests to confirm they all FAIL (RED):
    ```
    cd apps/feishu && npx vitest run src/__tests__/scrollback-cache.test.ts
    ```
    All tests must fail with "not implemented" errors.
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere/apps/feishu && npx vitest run src/__tests__/scrollback-cache.test.ts 2>&1 | tail -20</automated>
    All tests FAIL (RED). The test file imports from scrollback-cache.ts, all methods throw "not implemented".
  </verify>
  <done>
    - scrollback-cache.test.ts exists with 8+ test cases covering cache API
    - scrollback-cache.ts exists as stub with all methods throwing
    - terminal-scrollback.spec.ts exists with E2E test (skipped)
    - `vitest run` shows all unit tests FAILING
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: GREEN -- Implement ScrollbackCache, update store/viewport/chat wiring</name>
  <files>
    apps/feishu/src/services/scrollback-cache.ts
    apps/feishu/src/stores/terminal-store.ts
    apps/feishu/src/components/terminal-viewport/index.tsx
    apps/feishu/src/components/terminal-viewport/index.css
    apps/feishu/src/pages/chat/index.tsx
  </files>
  <action>
    **Step 1: Implement ScrollbackCache (GREEN the unit tests)**

    Fill in `apps/feishu/src/services/scrollback-cache.ts` following the proxy's `TerminalFrameRenderer` cache pattern exactly:
    - Internal Map<number, TermLine> for lineId -> line mapping
    - Track _oldestLineId, _newestLineId bounds
    - `applyLinesResponse`: iterate lines array, store each at fromLineId + index, update bounds
    - `getCachedLines`: return array of TermLine|null by checking Map.get for each lineId
    - `getMissingRange`: scan range for uncached ids, return contiguous uncovered range or null
    - `isAtOldest(fromLineId)`: return fromLineId <= this._oldestLineId
    - `clearCache`: clear Map, reset bounds
    - Run tests: `cd apps/feishu && npx vitest run src/__tests__/scrollback-cache.test.ts` -- all must pass

    **Step 2: Update terminal-store with scrollback state**

    Add to `TerminalStoreState`:
    ```typescript
    scrollbackCache: ScrollbackCache;
    scrollbackLines: TermLine[];   // lines above viewport from cache, for rendering
    isLoadingScrollback: boolean;
    isAtOldest: boolean;           // reached oldest available line
    userScrolledUp: boolean;       // user is browsing history, don't auto-scroll
    ```

    CRITICAL: Also update `initialTerminalState` to include default values for ALL new fields:
    ```typescript
    scrollbackCache: new ScrollbackCache(),
    scrollbackLines: [],
    isLoadingScrollback: false,
    isAtOldest: false,
    userScrolledUp: false,
    ```
    Import ScrollbackCache at the top of the file. Without this, the reducer will crash on first dispatch because the initial state has no scrollbackCache instance.

    Add new actions to `TerminalAction`:
    ```typescript
    | { type: "APPLY_LINES_RESPONSE"; response: { fromLineId: number; oldestLineId: number; newestLineId: number; lines: TermLine[] } }
    | { type: "REQUEST_SCROLLBACK" }         // set isLoadingScrollback = true
    | { type: "SET_USER_SCROLLED_UP"; value: boolean }
    ```

    In reducer:
    - `APPLY_LINES_RESPONSE`: call scrollbackCache.applyLinesResponse, rebuild scrollbackLines from cache (get all cached lines from oldestLineId to newestLineId), set isLoadingScrollback = false, compute isAtOldest
    - `REQUEST_SCROLLBACK`: set isLoadingScrollback = true
    - `SET_USER_SCROLLED_UP`: set userScrolledUp flag
    - On `SET_TERMINAL_LINES`: if !userScrolledUp, keep auto-scroll behavior

    **Step 3: Update terminal-viewport for scrollback rendering**

    Modify `TerminalViewport` props:
    ```typescript
    interface TerminalViewportProps {
      lines: TermLine[];               // current viewport lines (live frame)
      scrollbackLines: TermLine[];     // history lines above viewport
      fontSize: number;
      onPinchZoom: (direction: "in" | "out") => void;
      onScrollToTop: () => void;       // callback when user scrolls near top
      onScrollPositionChange: (nearBottom: boolean) => void;
      isLoadingScrollback: boolean;
      isAtOldest: boolean;
    }
    ```

    Rendering logic:
    - Render scrollbackLines FIRST (history), then lines (viewport) in a single ScrollView
    - Keep existing `scrollIntoView` auto-scroll behavior but only when nearBottom is true
    - Detect scroll-near-top: use ScrollView's `onScroll` event. When `scrollTop < 100` (in PX, not design units) AND not isLoadingScrollback AND not isAtOldest, call onScrollToTop
    - Show a loading indicator at the very top when isLoadingScrollback is true: a simple `<View className="scrollback-loading"><Text>Loading history...</Text></View>`
    - When isAtOldest and scrollbackLines exist, show `<View className="scrollback-oldest"><Text>Beginning of session</Text></View>` at top
    - Use `onScrollPositionChange` to report nearBottom state (scrollTop + clientHeight >= scrollHeight - 50)

    CSS additions (750 design system values):
    ```css
    .scrollback-loading {
      text-align: center;
      padding: 20px 0;
      color: #666;
      font-size: 24px;
    }
    .scrollback-oldest {
      text-align: center;
      padding: 20px 0;
      color: #555;
      font-size: 22px;
    }
    ```

    **Step 4: Wire terminal_lines_request/response in chat page**

    In `apps/feishu/src/pages/chat/index.tsx`, within the relay message handler useEffect:

    Add `terminal_lines_response` handling in the control message switch:
    ```typescript
    case "terminal_lines_response": {
      if (ctrl.sessionId !== sessionId) break;
      terminalDispatch({
        type: "APPLY_LINES_RESPONSE",
        response: {
          fromLineId: ctrl.fromLineId,
          oldestLineId: ctrl.oldestLineId,
          newestLineId: ctrl.newestLineId,
          lines: ctrl.lines,
        },
      });
      break;
    }
    ```

    Add scroll-to-top handler that sends terminal_lines_request:
    ```typescript
    const handleScrollToTop = useCallback(() => {
      if (!relay || !sessionId || !checkConnected()) return;
      const cache = terminalStateRef.current.scrollbackCache;
      // Request 50 lines before the oldest cached line
      const fromLineId = cache.oldestLineId > 0
        ? Math.max(0, cache.oldestLineId - 50)
        : 0;
      const count = cache.oldestLineId > 0
        ? cache.oldestLineId - fromLineId
        : 50;
      if (count <= 0) return;
      terminalDispatch({ type: "REQUEST_SCROLLBACK" });
      relay.sendControl({
        type: "terminal_lines_request",
        sessionId,
        fromLineId,
        count,
      });
    }, [relay, sessionId, checkConnected, terminalDispatch]);
    ```

    Add scroll position change handler:
    ```typescript
    const handleTerminalScrollChange = useCallback((nearBottom: boolean) => {
      terminalDispatch({ type: "SET_USER_SCROLLED_UP", value: !nearBottom });
    }, [terminalDispatch]);
    ```

    Update TerminalViewport JSX in chat page to pass new props:
    ```tsx
    <TerminalViewport
      lines={terminalState.lines}
      scrollbackLines={terminalState.scrollbackLines}
      fontSize={terminalState.fontSize}
      onPinchZoom={handlePinchZoom}
      onScrollToTop={handleScrollToTop}
      onScrollPositionChange={handleTerminalScrollChange}
      isLoadingScrollback={terminalState.isLoadingScrollback}
      isAtOldest={terminalState.isAtOldest}
    />
    ```

    **Step 5: Verify everything**
    - Run unit tests: `cd apps/feishu && npx vitest run src/__tests__/scrollback-cache.test.ts`
    - Build H5: `cd apps/feishu && pnpm run build:h5` -- must compile without errors
    - Run all feishu unit tests: `cd apps/feishu && npx vitest run` -- no regressions
  </action>
  <verify>
    <automated>cd /Users/admin/workspace/cc_anywhere/apps/feishu && npx vitest run src/__tests__/scrollback-cache.test.ts && pnpm run build:h5 2>&1 | tail -5</automated>
    All scrollback-cache unit tests PASS (GREEN). H5 build succeeds.
  </verify>
  <done>
    - All scrollback-cache.test.ts tests pass (GREEN)
    - H5 build compiles without TypeScript errors
    - All existing feishu unit tests still pass (no regressions)
    - terminal-viewport renders scrollbackLines above viewport lines
    - Scrolling to top fires onScrollToTop callback
    - chat/index.tsx sends terminal_lines_request and handles terminal_lines_response
    - Loading indicator shows when fetching, "Beginning of session" shows at oldest
    - Auto-scroll to bottom preserved when user is at bottom
    - New frames do not yank scroll when user is browsing scrollback
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>Terminal scrollback: scroll up in PTY viewport to load and view history lines on demand</what-built>
  <how-to-verify>
    1. Start relay and proxy: `pnpm --filter relay run dev` and `pnpm --filter proxy run dev`
    2. Build and serve H5: `cd apps/feishu && pnpm run build:h5 && pnpm run serve:h5`
    3. Open browser at http://localhost:5175/#/pages/proxy-select/index (390x844 viewport)
    4. Select proxy, select a PTY session with some output history
    5. In the terminal viewport, scroll up toward the top
    6. Verify: loading indicator appears briefly, then older lines render above
    7. Continue scrolling up -- more history loads
    8. When you reach the beginning, verify "Beginning of session" appears
    9. Scroll back to bottom -- verify live terminal updates resume auto-scrolling
    10. While browsing scrollback (scrolled up), verify new output does NOT yank your scroll position
  </how-to-verify>
  <resume-signal>Type "approved" or describe issues</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| relay -> client | terminal_lines_response data comes from proxy via relay; could contain malformed lines |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-quick-01 | T (Tampering) | scrollback-cache | accept | Lines come from our own proxy over authenticated relay; same trust model as terminal_frame |
| T-quick-02 | D (Denial of Service) | scrollback-cache | mitigate | Cache is Map<number, TermLine>; clearCache on session switch prevents unbounded growth. Request count capped at 50 per request. |
</threat_model>

<verification>
1. `cd apps/feishu && npx vitest run` -- all unit tests pass
2. `cd apps/feishu && pnpm run build:h5` -- compiles without errors
3. Manual: scroll up in PTY viewport loads history; scroll to bottom resumes auto-scroll
</verification>

<success_criteria>
- ScrollbackCache unit tests all pass (RED then GREEN)
- H5 build compiles without errors
- PTY terminal viewport supports scrolling up to load history
- History lines render above current viewport seamlessly
- Loading state and "oldest reached" boundary are visible to user
- Auto-scroll behavior preserved when at bottom
- Scroll position stable when user is browsing scrollback
</success_criteria>

<output>
After completion, create `.planning/quick/260412-sbg-terminal-scrollback-client-side-pty-hist/260412-sbg-SUMMARY.md`
</output>
