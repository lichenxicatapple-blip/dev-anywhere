type ScrollToBottomAction = "blocked-by-review" | "noop" | "follow";

interface ScrollToBottomPolicyInput {
  force: boolean;
  reviewing: boolean;
  viewportY: number;
  expectedYdisp: number;
  scrollTop: number;
  bottomScrollTop: number;
  atBottom: boolean;
}

interface ScrollToBottomPolicyResult {
  action: ScrollToBottomAction;
}

export function decideScrollToBottomAction(
  input: ScrollToBottomPolicyInput,
): ScrollToBottomPolicyResult {
  if (!input.force && input.reviewing) return { action: "blocked-by-review" };
  if (
    !input.reviewing &&
    input.viewportY === input.expectedYdisp &&
    (Math.abs(input.scrollTop - input.bottomScrollTop) <= 1 || (!input.force && input.atBottom))
  ) {
    return { action: "noop" };
  }
  return { action: "follow" };
}

interface CursorAwareClampInput {
  rawScrollTop: number;
  referenceScrollTop: number;
  bottomScrollTop: number;
  domMaxScrollTop: number;
  reviewing: boolean;
  atBottomThreshold: number;
}

interface CursorAwareClampResult {
  action: "keep" | "clamp";
  scrollTop: number;
}

export function resolvePtyNativeScrollMax({
  reviewing,
  referenceScrollTop,
  bottomScrollTop,
  domMaxScrollTop,
  atBottomThreshold,
}: {
  reviewing: boolean;
  referenceScrollTop: number;
  bottomScrollTop: number;
  domMaxScrollTop: number;
  atBottomThreshold: number;
}): number {
  // Following is bounded by the semantic live tail. Reviewing uses the DOM range
  // only when the gesture started inside the preserved range that may temporarily
  // sit beyond the new live-tail coordinate after a viewport/keyboard relayout.
  const usesPreservedReviewRange =
    reviewing && referenceScrollTop > bottomScrollTop + atBottomThreshold;
  return usesPreservedReviewRange ? domMaxScrollTop : Math.min(domMaxScrollTop, bottomScrollTop);
}

export function shouldWheelCommitPtySemanticBottom({
  reviewing,
  deltaY,
  currentScrollTop,
  bottomScrollTop,
  atBottomThreshold,
}: {
  reviewing: boolean;
  deltaY: number;
  currentScrollTop: number;
  bottomScrollTop: number;
  atBottomThreshold: number;
}): boolean {
  if (!reviewing || deltaY <= 0) return false;

  // A keyboard/viewport relayout can preserve a reviewed DOM offset beyond the new
  // semantic live tail. A downward wheel at that native boundary must not reverse
  // direction by snapping back to the smaller semantic coordinate.
  if (currentScrollTop > bottomScrollTop + atBottomThreshold) return false;

  // Once an ordinary review gesture reaches the semantic boundary, commit the exact
  // semantic frame instead of reconstructing it through the review pixel-to-row anchor.
  // The latter can legitimately land one row short when the accumulated pixel delta is
  // fractional. This also closes stale review state when pixels are already at bottom.
  return currentScrollTop + deltaY >= bottomScrollTop - atBottomThreshold;
}

export function decideCursorAwareClamp(input: CursorAwareClampInput): CursorAwareClampResult {
  const maxScrollTop = resolvePtyNativeScrollMax(input);
  if (input.rawScrollTop <= maxScrollTop + 1) {
    return { action: "keep", scrollTop: input.rawScrollTop };
  }
  return { action: "clamp", scrollTop: maxScrollTop };
}
