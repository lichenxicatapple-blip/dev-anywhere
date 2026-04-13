# Quick Task 260413-g0u: Scroll Anchor + Prefetch Cache

## What Changed

Replaced relative `viewportOffset` scrolling with absolute `anchorLineId` positioning. Added client-side prefetch cache for historical frames.

### Server Side (Proxy)
- **TerminalTracker**: `anchorLineId: number | null` replaces `viewportOffset`. `isAnchored()` / `getAnchorLineId()` / `clearAnchor()` API. Scroll up/down manipulates absolute line IDs.
- **terminal.ts**: Tap callback no longer resets scroll — anchor persists through PTY output. Scroll handler includes `anchorLineId` and `newestLineId` in frame payload.
- **frame-pusher.ts**: `push()` / `forceFull()` skip when tracker is anchored — no live frames during scroll.
- **session.ts schema**: `anchorLineId` and `newestLineId` optional fields on TerminalFrameFullSchema.

### Client Side (Feishu)
- **terminal-store.ts**: `frameCache: Map<number, TermLine[]>` for cached historical frames. `anchorLineId` / `newestLineId` state tracking. `CACHE_FRAME` / `SET_SCROLL_STATE` / `CLEAR_ANCHOR` actions.
- **chat/index.tsx**: Cache-first scroll (check local cache before network request). Prefetch adjacent pages after receiving scroll response. Tap-to-return handler.
- **terminal-viewport**: "Scrolled" indicator with tap-to-return. `isScrolled` and `onTapToReturn` props.

## Commits
- `2429ebf` feat(quick-260413-g0u): anchor-based scroll with output protection in proxy
- `8574465` feat(quick-260413-g0u): client-side prefetch cache and scroll anchor state
