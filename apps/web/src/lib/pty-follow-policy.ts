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
