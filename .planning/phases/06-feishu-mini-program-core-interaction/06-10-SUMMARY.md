---
phase: "06"
plan: "10"
subsystem: feishu-mini-program
tags: [state-management, responsive, components, app-lifecycle]
dependency_graph:
  requires: ["06-01", "06-05", "06-06"]
  provides: ["state-stores", "responsive-hook", "status-line", "safe-area-header", "app-lifecycle"]
  affects: ["06-07", "06-08", "06-09", "06-11"]
tech_stack:
  added: []
  patterns: ["React Context + useReducer", "Taro.onWindowResize", "class-based responsive"]
key_files:
  created:
    - apps/feishu/src/stores/app-store.ts
    - apps/feishu/src/stores/session-store.ts
    - apps/feishu/src/stores/terminal-store.ts
    - apps/feishu/src/stores/chat-store.ts
    - apps/feishu/src/stores/command-store.ts
    - apps/feishu/src/stores/file-store.ts
    - apps/feishu/src/hooks/use-screen-size.ts
    - apps/feishu/src/components/status-line/index.tsx
    - apps/feishu/src/components/status-line/index.css
    - apps/feishu/src/components/safe-area-header/index.tsx
    - apps/feishu/src/components/safe-area-header/index.css
    - apps/feishu/src/__tests__/use-screen-size.test.ts
  modified:
    - apps/feishu/src/app.ts
    - apps/feishu/src/app.config.ts
    - apps/feishu/src/app.css
decisions:
  - "Stores use import type from @cc-anywhere/shared following post-06-06 refactoring that eliminated type mirrors"
  - "useScreenSize classifies by width only using two breakpoints (500px landscape, 860px desktop)"
  - "App lifecycle creates WebSocketManager and RelayClient in useEffect, reconnects on onShow"
metrics:
  duration: "6min"
  completed: "2026-04-10"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 15
  tests_added: 11
---

# Phase 06 Plan 10: State Stores, Responsive Hook, Components, App Lifecycle Summary

**Six state stores with Context+useReducer, useScreenSize hook with real-time Taro.onWindowResize tracking, SafeAreaHeader and StatusLine components, app lifecycle with WebSocket init, responsive CSS variables with three breakpoint tiers**

## Tasks Completed

### Task 1: Six state stores with React Context + useReducer pattern

Created complete state management layer consumed by all three production pages:

- **app-store** -- connection status, selected proxy (id+name), clientId with localStorage persistence, relay URL
- **session-store** -- active session list (SessionInfo[]), history sessions (HistorySession[]), current session tracking with mode
- **terminal-store** -- PTY grid lines (TermLine[]), font size with FONT_SIZES array and localStorage persistence, PTY semantic state, approval tool
- **chat-store** -- ChatMessage list with streaming support (isPartial), tool calls with collapse toggle, approval queue, quoted message
- **command-store** -- slash command list cache with lastUpdated timestamp
- **file-store** -- directory tree Map<string, DirEntry[]> cache with CLEAR_TREE action for reconnect

Each store exports: Provider, DispatchProvider, useState hook, useDispatch hook, reducer, initial state, action types. All reducers have default case returning current state (T-06-28 mitigation).

### Task 2: useScreenSize hook, SafeAreaHeader, StatusLine, app lifecycle, app config, global styles (TDD)

**useScreenSize hook** -- Pure `classifyScreen` function with two breakpoints (500px landscape, 860px desktop). Hook subscribes to `Taro.onWindowResize` for real-time orientation/resize tracking. Returns category, className, windowWidth/Height, deviceType, statusBarHeight, safeArea. 11 tests passing.

**SafeAreaHeader** -- Fixed-position custom navigation bar with dynamic statusBarHeight padding, back button (44x44 tap target), centered title with ellipsis, optional right slot. Supports transparent mode for dark backgrounds.

**StatusLine** -- 4px session state indicator bar. Colors: idle green (#52C41A), working blue (#1890FF) with sweep animation, waiting_approval amber (#FAAD14) with breathing animation, terminated gray (#999999).

**App lifecycle** -- App component initializes WebSocketManager and RelayClient in useEffect, wraps children with AppProvider/AppDispatchProvider. Reconnects on Taro.useDidShow (foreground return). ClientId loaded from storage or generated.

**App config** -- Production pages registered (proxy-select, session-list, chat) before spike pages. `pageOrientation: "auto"` for landscape support. `ext.defaultPages.PCMode: "appCenter"` for Feishu PC large window mode.

**Global CSS** -- 18 CSS variables for colors, spacing, responsive overrides. Three breakpoint tiers: portrait (default), landscape (.screen-landscape), desktop (.screen-desktop). Animations: pulse, breathing, sweepRight, bubbleEntranceLeft/Right.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Type mirrors eliminated, stores use import type from shared**
- **Found during:** Task 1
- **Issue:** Plan references type mirrors at `apps/feishu/src/types/envelope.ts` etc., but commit 4c5ee30 eliminated type mirrors in favor of direct `import type` from `@cc-anywhere/shared`
- **Fix:** Stores use `import type { SessionInfo, HistorySession } from "@cc-anywhere/shared"` following the current codebase pattern. All imports are type-only, erased at compile time, no zod runtime dependency.
- **Files modified:** All stores that reference shared types
- **Commit:** f0e6cb8

**2. [Rule 3 - Blocking] Worktree lacks node_modules for test execution**
- **Found during:** Task 2 TDD
- **Issue:** Worktree doesn't have node_modules symlinks, causing `@tarojs/taro` and `react` resolution failures in vitest
- **Fix:** Added vi.mock for both `@tarojs/taro` and `react` in the test file since tests only exercise pure functions (classifyScreen, getResponsiveClass)
- **Files modified:** apps/feishu/src/__tests__/use-screen-size.test.ts
- **Commit:** 9a99f19

## Commits

| # | Hash | Message |
|---|------|---------|
| 1 | f0e6cb8 | feat(06-10): six state stores with Context+useReducer pattern |
| 2 | c08c358 | test(06-10): add failing tests for classifyScreen and getResponsiveClass |
| 3 | 9a99f19 | feat(06-10): useScreenSize hook, SafeAreaHeader, StatusLine, app lifecycle, responsive CSS |

## Self-Check: PASSED

All 15 files verified present. All 3 commits verified in git log.
