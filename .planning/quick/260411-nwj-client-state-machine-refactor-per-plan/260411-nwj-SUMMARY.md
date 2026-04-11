# Quick Task 260411-nwj: Client State Machine Refactor

## Result

All 6 tasks completed. 112 tests pass (103 existing + 9 new). TypeScript compiles cleanly.

## Commits

| Commit | Task | Description |
|--------|------|-------------|
| 144b154 | Task 1 (Step 5) | Fix reducer side effect + chat stale closure |
| cf456b9 | Task 2 (Step 4) | Eliminate duplicate historySessions and dirEntries state |
| 15d7630 | Task 3 (Step 1) | Introduce AppPhase enum, SET_PHASE action, Storage transition helpers |
| 4c9b30c | Task 4 (Step 2+6) | Phase-aware navigation, stale closure fix in app.tsx, cold start unified |
| 7162f68 | Task 5 (Step 3) | Remove component lifecycle Storage cleanup |

## Key Changes

- **AppPhase enum** with 6 states replaces boolean combinations for stage identification
- **transitionToPhase** helper centralizes Storage cleanup, keeping reducer pure
- **stateRef pattern** in app.tsx prevents stale closures in ws/relay handlers
- **useDidShow fallback** in proxy-select and session-list corrects phase on physical back/swipe
- **Cold start** moved from proxy-select to app.tsx proxy_list_response handler
- **Duplicate state eliminated**: historySessions from session-store, dirEntries from file-store
- **terminal-store reducer** is now a pure function (Taro.setStorageSync moved to useEffect)

## Files Modified

- `apps/feishu/src/stores/app-store.ts` (+42) -- AppPhase, SET_PHASE, transitionToPhase
- `apps/feishu/src/stores/terminal-store.ts` (-1) -- removed Storage side effect
- `apps/feishu/src/app.tsx` (+88/-4) -- stateRef, phase-aware handlers, cold start
- `apps/feishu/src/pages/proxy-select/index.tsx` (+34/-34) -- cold start removed, useDidShow added
- `apps/feishu/src/pages/session-list/index.tsx` (+48/-48) -- duplicate state removed, phase transitions
- `apps/feishu/src/pages/chat/index.tsx` (+23/-23) -- stale closure fix, font size useEffect
- `apps/feishu/src/__tests__/app-store.test.ts` (+74) -- 9 new tests
