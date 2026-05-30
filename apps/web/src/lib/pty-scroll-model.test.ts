import { describe, expect, it } from "vitest";
import {
  computeTouchHorizontalExpectation,
  computeTouchMovement,
  computeTouchScrollExpectation,
  decideFollowCursorY,
  decideTouchGestureFinish,
} from "./pty-scroll-model";

describe("pty scroll model", () => {
  describe("decideFollowCursorY", () => {
    it("lets user review intent win and clears the previous cursor row", () => {
      expect(
        decideFollowCursorY({
          reviewing: true,
          cellH: 18,
          rows: 40,
          visibleContentHeight: 320,
          cursorBufferRow: 200,
          prevCursorBufferRow: 199,
          cursorInViewport: false,
          targetScrollTop: 3000,
          currentScrollTop: 0,
        }),
      ).toEqual({
        action: "skip",
        reason: "intent",
        nextPrevCursorBufferRow: null,
        cursorDeltaRows: null,
      });
    });

    it("skips short hosts and clears stale cursor history", () => {
      expect(
        decideFollowCursorY({
          reviewing: false,
          cellH: 10,
          rows: 20,
          visibleContentHeight: 220,
          cursorBufferRow: 20,
          prevCursorBufferRow: 19,
          cursorInViewport: false,
          targetScrollTop: 100,
          currentScrollTop: 0,
        }),
      ).toEqual({
        action: "skip",
        reason: "shortHost",
        nextPrevCursorBufferRow: null,
        cursorDeltaRows: null,
      });
    });

    it("does not follow same-row renders when the cursor is already visible", () => {
      expect(
        decideFollowCursorY({
          reviewing: false,
          cellH: 18,
          rows: 40,
          visibleContentHeight: 320,
          cursorBufferRow: 200,
          prevCursorBufferRow: 200,
          cursorInViewport: true,
          targetScrollTop: 3000,
          currentScrollTop: 0,
        }),
      ).toEqual({
        action: "skip",
        reason: "same-row",
        nextPrevCursorBufferRow: 200,
        cursorDeltaRows: 0,
      });
    });

    it("records the cursor row but skips when the cursor is visible", () => {
      expect(
        decideFollowCursorY({
          reviewing: false,
          cellH: 18,
          rows: 40,
          visibleContentHeight: 320,
          cursorBufferRow: 205,
          prevCursorBufferRow: 200,
          cursorInViewport: true,
          targetScrollTop: 3000,
          currentScrollTop: 0,
        }),
      ).toEqual({
        action: "skip",
        reason: "inViewport",
        nextPrevCursorBufferRow: 205,
        cursorDeltaRows: 5,
      });
    });

    it("returns a follow target when the cursor moved outside the viewport", () => {
      expect(
        decideFollowCursorY({
          reviewing: false,
          cellH: 18,
          rows: 40,
          visibleContentHeight: 320,
          cursorBufferRow: 205,
          prevCursorBufferRow: 200,
          cursorInViewport: false,
          targetScrollTop: 3000,
          currentScrollTop: 1000,
        }),
      ).toEqual({
        action: "follow",
        reason: "cursor-outside",
        nextPrevCursorBufferRow: 205,
        cursorDeltaRows: 5,
        targetScrollTop: 3000,
      });
    });
  });

  describe("decideTouchGestureFinish", () => {
    it("keeps a bottom-origin touch following when it stayed near the start", () => {
      expect(
        decideTouchGestureFinish({
          touchStartScrollTop: 1000,
          liveScrollTop: 996,
          atBottomThreshold: 8,
          touchStartedAtCursorAwareBottom: true,
          anchorIsAtBottom: false,
          reviewedDuringTouch: false,
        }),
      ).toEqual({
        atCursorAwareBottomForIntent: true,
        releaseOnSemanticBottom: false,
      });
    });

    it("does not release review intent after review was notified", () => {
      expect(
        decideTouchGestureFinish({
          touchStartScrollTop: 1000,
          liveScrollTop: 1400,
          atBottomThreshold: 8,
          touchStartedAtCursorAwareBottom: true,
          anchorIsAtBottom: true,
          reviewedDuringTouch: true,
        }),
      ).toEqual({
        atCursorAwareBottomForIntent: false,
        releaseOnSemanticBottom: false,
      });
    });
  });

  describe("touch geometry", () => {
    it("computes movement from nullable touch coordinates", () => {
      expect(
        computeTouchMovement({
          startX: 20,
          startY: 100,
          currentX: 44,
          currentY: 82,
        }),
      ).toMatchObject({
        dx: 24,
        dy: -18,
        absDx: 24,
        absDy: 18,
        startY: 100,
      });

      expect(
        computeTouchMovement({
          startX: 20,
          startY: null,
          currentX: 44,
          currentY: 82,
        }),
      ).toBeNull();
    });

    it("anchors vertical touch expectation at cursor-aware bottom when touch started there", () => {
      expect(
        computeTouchScrollExpectation({
          touchActive: true,
          touchStartScrollTop: 700,
          touchStartY: 300,
          currentY: 350,
          touchStartedAtCursorAwareBottom: true,
          bottomScrollTop: 1000,
          domMaxScrollTop: 1200,
        }),
      ).toMatchObject({
        gestureBaseScrollTop: 1000,
        expectedScrollTop: 950,
        cursorAwareMaxScrollTop: 1000,
        touchDeltaY: 50,
      });
    });

    it("clamps vertical touch expectation to the cursor-aware maximum", () => {
      expect(
        computeTouchScrollExpectation({
          touchActive: true,
          touchStartScrollTop: 700,
          touchStartY: 300,
          currentY: 100,
          touchStartedAtCursorAwareBottom: false,
          bottomScrollTop: 820,
          domMaxScrollTop: 1200,
        }),
      ).toMatchObject({
        gestureBaseScrollTop: 700,
        expectedScrollTop: 820,
        cursorAwareMaxScrollTop: 820,
      });
    });

    it("computes horizontal touch expectation and clamps it to available overflow", () => {
      expect(
        computeTouchHorizontalExpectation({
          touchActive: true,
          touchStartClientX: 320,
          touchStartScrollLeft: 40,
          currentX: 100,
          maxScrollLeft: 180,
        }),
      ).toEqual({
        touchStartX: 320,
        currentX: 100,
        touchStartScrollLeft: 40,
        expectedScrollLeft: 180,
        maxScrollLeft: 180,
        touchDeltaX: -220,
      });
    });
  });
});
