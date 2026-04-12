---
phase: quick-260412-sbg
verified: 2026-04-12T12:44:23Z
status: human_needed
score: 6/6
overrides_applied: 0
human_verification:
  - test: "Scroll up in PTY terminal viewport to load history lines"
    expected: "Loading indicator appears briefly, then older lines render above the current viewport"
    why_human: "Requires live relay+proxy to test real WebSocket round-trip and visual rendering"
  - test: "Verify auto-scroll resumes at bottom, no yank when scrolled up"
    expected: "New frames auto-scroll only when user is at bottom; scroll position stable when browsing history"
    why_human: "Scroll behavior depends on real-time frame updates and touch interaction"
  - test: "'Beginning of session' boundary displayed at oldest line"
    expected: "When all history is loaded, a boundary marker appears at the very top"
    why_human: "Depends on proxy having finite scrollback and the response indicating oldest boundary"
---

# Quick Task: Terminal Scrollback -- Verification Report

**Task Goal:** Client-side PTY history scrolling with TDD: ScrollbackCache, TerminalViewport scroll-near-top detection, terminal_lines_request/response handling, Chat page wiring.
**Verified:** 2026-04-12T12:44:23Z
**Status:** human_needed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can scroll up in PTY terminal viewport to see history lines beyond current viewport | VERIFIED | `TerminalViewport` renders `allLines = [...scrollbackLines, ...lines]` (index.tsx:121). scrollbackLines populated via APPLY_LINES_RESPONSE. ScrollView has `scrollY` enabled. |
| 2 | Scrolling to top triggers a terminal_lines_request to fetch older lines | VERIFIED | `handleScroll` in viewport detects `scrollTop < 100` and calls `onScrollToTop()` (index.tsx:98). Chat page `handleScrollToTop` (chat/index.tsx:281-298) sends `relay.sendControl({ type: "terminal_lines_request" })`. |
| 3 | Fetched history lines render above the current viewport seamlessly | VERIFIED | `allLines = [...scrollbackLines, ...lines]` (index.tsx:121) prepends history. Same `.terminal-line` rendering path for both (index.tsx:149-169). |
| 4 | User stops seeing a loading indicator when oldest available line is reached | VERIFIED | `scrollback-oldest` View shows "Beginning of session" when `!isLoadingScrollback && isAtOldest && scrollbackLines.length > 0` (index.tsx:144-147). `handleScroll` checks `!isAtOldest` before triggering `onScrollToTop()` (index.tsx:98), preventing further requests. |
| 5 | New terminal_frame updates still auto-scroll to bottom when user is at bottom | VERIFIED | `useEffect` on lines change (index.tsx:50-56) sets `scrollRef.current` to last line ID only when `!userScrolledUpRef.current`. ScrollView uses `scrollIntoView={scrollRef.current}`. |
| 6 | When user is browsing scrollback, new frames do NOT yank scroll position | VERIFIED | Guard `!userScrolledUpRef.current` (index.tsx:52) prevents auto-scroll. `userScrolledUpRef.current` set via `handleScroll` -> `onScrollPositionChange` -> `SET_USER_SCROLLED_UP` dispatch chain. |

**Score:** 6/6 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/feishu/src/services/scrollback-cache.ts` | ScrollbackCache class: lineId-indexed cache with miss detection, boundary tracking | VERIFIED | 71 lines. Full implementation with Map<number, TermLine> cache, applyLinesResponse, getCachedLines, getMissingRange, isAtOldest, clearCache, cacheSize/oldestLineId/newestLineId getters. |
| `apps/feishu/src/__tests__/scrollback-cache.test.ts` | Unit tests for ScrollbackCache | VERIFIED | 187 lines, 15 tests, all passing. Covers empty cache, populated cache, partial cache hit, getMissingRange, isAtOldest, clearCache, multiple responses. |
| `apps/feishu/e2e/terminal-scrollback.spec.ts` | E2E test for scroll-to-load-history behavior | VERIFIED | 53 lines. Properly skipped with `test.skip` since it requires live proxy+relay. Tests scroll-to-top triggering scrollback load. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| terminal-viewport/index.tsx | scrollback-cache.ts | ScrollbackCache via terminal-store state | WIRED (alternative path) | Plan expected direct cache method calls in viewport. Actual: store reducer calls `cache.applyLinesResponse()` and `buildScrollbackLines()`, passes `scrollbackLines` array as prop to viewport. Architecturally cleaner -- viewport doesn't need cache internals. |
| chat/index.tsx | relay.sendControl | terminal_lines_request when scroll hits top | WIRED | `handleScrollToTop` (line 281-298) accesses `terminalStateRef.current.scrollbackCache.oldestLineId`, computes range, calls `relay.sendControl({ type: "terminal_lines_request", ... })`. |
| chat/index.tsx | terminal-store | APPLY_LINES_RESPONSE routes terminal_lines_response to cache | WIRED | `terminal_lines_response` case (line 188-200) dispatches `{ type: "APPLY_LINES_RESPONSE", response: { ... } }`. Reducer (terminal-store.ts:83-91) calls `cache.applyLinesResponse()` and rebuilds `scrollbackLines`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| terminal-viewport | scrollbackLines prop | terminal-store reducer -> buildScrollbackLines(cache) -> ScrollbackCache.getCachedLines | Yes -- cache populated from relay terminal_lines_response | FLOWING |
| terminal-viewport | lines prop | terminal-store SET_TERMINAL_LINES from terminal_frame relay messages | Yes -- live PTY frame data | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| ScrollbackCache unit tests pass | `npx vitest run src/__tests__/scrollback-cache.test.ts` | 15 tests passed in 100ms | PASS |
| H5 build compiles | `pnpm run build:h5` | webpack compiled successfully | PASS |
| All feishu unit tests (regression) | `npx vitest run` | 151 passed, 2 failed (pre-existing: phase-machine.test.ts + cold-start.test.ts expect old URL format without `&mode=json`) | PASS (no regressions from this task) |

### Requirements Coverage

No specific requirement IDs declared for this quick task.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | No anti-patterns found in any modified file |

### Human Verification Required

### 1. Scroll-Up History Loading

**Test:** Start relay and proxy. Build and serve H5. Open browser at `http://localhost:5175/#/pages/proxy-select/index` (390x844 viewport). Select proxy, select a PTY session with output history. Scroll up to the top of the terminal viewport.
**Expected:** Loading indicator ("Loading history...") appears briefly, then older terminal lines render above the current viewport. Scrolling further up loads more history.
**Why human:** Requires live relay+proxy WebSocket round-trip. Visual rendering of history lines needs manual inspection.

### 2. Auto-Scroll and Scroll Stability

**Test:** While at the bottom of the terminal, generate new output (run a command). While scrolled up browsing history, generate new output.
**Expected:** At bottom: viewport auto-scrolls to show new output. Scrolled up: new output does NOT yank scroll position; viewport stays at the user's browsed position.
**Why human:** Real-time scroll behavior depends on PTY frame updates and touch interaction timing.

### 3. Oldest Boundary Display

**Test:** Scroll all the way up until no more history is available.
**Expected:** "Beginning of session" text appears at the very top. No further loading indicators or requests are triggered.
**Why human:** Depends on proxy having finite scrollback and correctly reporting oldest boundary in response.

### Gaps Summary

No code-level gaps found. All 6 observable truths are verified at the code level with proper artifacts, wiring, and data flow. The 2 pre-existing test failures (phase-machine.test.ts, cold-start.test.ts) are unrelated to this task -- they test URL format that was changed in a prior commit.

Human verification is required to confirm the full end-to-end behavior with a live relay+proxy, as the scrollback feature depends on real WebSocket communication and visual rendering.

---

_Verified: 2026-04-12T12:44:23Z_
_Verifier: Claude (gsd-verifier)_
