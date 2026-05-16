export type ScrollToBottomAction = "blocked-by-review" | "noop" | "follow";

export interface ScrollToBottomPolicyInput {
  force: boolean;
  reviewing: boolean;
  viewportY: number;
  expectedYdisp: number;
  scrollTop: number;
  bottomScrollTop: number;
  atBottom: boolean;
}

export interface ScrollToBottomPolicyResult {
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

export interface CursorAwareClampInput {
  rawScrollTop: number;
  bottomScrollTop: number;
  domMaxScrollTop: number;
}

export interface CursorAwareClampResult {
  action: "keep" | "clamp";
  scrollTop: number;
}

export function decideCursorAwareClamp(input: CursorAwareClampInput): CursorAwareClampResult {
  const hasCursorAwareBottom = input.bottomScrollTop < input.domMaxScrollTop - 1;
  if (!hasCursorAwareBottom || input.rawScrollTop <= input.bottomScrollTop + 1) {
    return { action: "keep", scrollTop: input.rawScrollTop };
  }
  return { action: "clamp", scrollTop: input.bottomScrollTop };
}

export interface TouchMoveBoundaryInput {
  previousClientX?: number | null;
  currentClientX?: number | null;
  previousClientY: number | null;
  currentClientY: number | null;
  scrollTop: number;
  bottomScrollTop: number;
  domMaxScrollTop: number;
  atBottom: boolean;
}

export interface TouchMoveBoundaryResult {
  action: "allow" | "prevent";
  scrollTop?: number;
}

export function decideTouchMoveBoundary(input: TouchMoveBoundaryInput): TouchMoveBoundaryResult {
  if (input.previousClientY === null || input.currentClientY === null) {
    return { action: "allow" };
  }
  if (
    input.previousClientX !== undefined &&
    input.currentClientX !== undefined &&
    input.previousClientX !== null &&
    input.currentClientX !== null
  ) {
    const dx = Math.abs(input.currentClientX - input.previousClientX);
    const dy = Math.abs(input.currentClientY - input.previousClientY);
    if (dx > dy) {
      return { action: "allow" };
    }
  }
  const wantsScrollDown = input.currentClientY < input.previousClientY;
  const hasCursorAwareBottom = input.bottomScrollTop < input.domMaxScrollTop - 1;
  if (!wantsScrollDown || !hasCursorAwareBottom) {
    return { action: "allow" };
  }
  const atCursorAwareBottom = input.scrollTop >= input.bottomScrollTop - 1;
  const projectedScrollTop = input.scrollTop + (input.previousClientY - input.currentClientY);
  const wouldCrossCursorAwareBottom = projectedScrollTop >= input.bottomScrollTop - 1;
  if ((atCursorAwareBottom && input.atBottom) || wouldCrossCursorAwareBottom) {
    return { action: "prevent", scrollTop: input.bottomScrollTop };
  }
  return { action: "allow" };
}
