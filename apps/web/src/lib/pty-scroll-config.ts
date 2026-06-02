// Centralized thresholds for the PTY scroll controller. These are browser-behavior
// guards, not visual design tokens; keep each value tied to the incident it protects.
export const PTY_SCROLL_CONFIG = {
  bottom: {
    defaultThresholdPx: 8,
  },
  horizontal: {
    nativeIntentThresholdPx: 48,
  },
  rawInput: {
    // Input/focus follow can briefly shrink/re-expand the DOM scroll range before the next render
    // settles. Keep this scoped to scheduled follow-to-bottom paths; keyboard visualViewport drift
    // is intentionally not restored here.
    recentLayoutDriftMs: 1_000,
  },
  touch: {
    // Only repair native scroll positions that are physically impossible for the active gesture.
    // Smaller deltas are left to the browser, otherwise slow finger drags become jittery.
    scrollJumpMinThresholdPx: 512,
    // Real Android can report scrollTop near host.style.top during a bottom touch. This guard fixes
    // the catastrophic replay, while ignoring the tiny host-top-adjacent deltas seen on real devices.
    hostTopJumpMinThresholdPx: 64,
    gestureSlopPx: 16,
    horizontalGestureSlopPx: 6,
    horizontalLockRatio: 1,
    verticalLockRatio: 1.25,
    nativeScrollRecentMs: 500,
  },
} as const;
