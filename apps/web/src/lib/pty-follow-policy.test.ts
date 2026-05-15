import { describe, expect, it } from "vitest";
import {
  decideCursorAwareClamp,
  decideScrollToBottomAction,
  decideTouchMoveBoundary,
} from "./pty-follow-policy";

describe("PTY follow policy", () => {
  describe("decideScrollToBottomAction", () => {
    it("blocks passive follow while the user is reviewing history", () => {
      expect(
        decideScrollToBottomAction({
          force: false,
          reviewing: true,
          viewportY: 10,
          expectedYdisp: 20,
          scrollTop: 100,
          bottomScrollTop: 400,
          atBottom: false,
        }),
      ).toEqual({ action: "blocked-by-review" });
    });

    it("allows forced follow even while reviewing", () => {
      expect(
        decideScrollToBottomAction({
          force: true,
          reviewing: true,
          viewportY: 10,
          expectedYdisp: 20,
          scrollTop: 100,
          bottomScrollTop: 400,
          atBottom: false,
        }),
      ).toEqual({ action: "follow" });
    });

    it("does not passively recenter when already at live bottom and the cursor remains visible", () => {
      expect(
        decideScrollToBottomAction({
          force: false,
          reviewing: false,
          viewportY: 390,
          expectedYdisp: 390,
          scrollTop: 8236.5,
          bottomScrollTop: 8227.5,
          atBottom: true,
        }),
      ).toEqual({ action: "noop" });
    });

    it("follows when not reviewing and not already at bottom", () => {
      expect(
        decideScrollToBottomAction({
          force: false,
          reviewing: false,
          viewportY: 380,
          expectedYdisp: 390,
          scrollTop: 7800,
          bottomScrollTop: 8236.5,
          atBottom: false,
        }),
      ).toEqual({ action: "follow" });
    });

    it("follows when the viewport is stale even if scrollTop is already near the bottom anchor", () => {
      expect(
        decideScrollToBottomAction({
          force: false,
          reviewing: false,
          viewportY: 389,
          expectedYdisp: 390,
          scrollTop: 8236.5,
          bottomScrollTop: 8236.5,
          atBottom: true,
        }),
      ).toEqual({ action: "follow" });
    });
  });

  describe("decideCursorAwareClamp", () => {
    it("clamps native scroll past cursor-aware bottom", () => {
      expect(
        decideCursorAwareClamp({
          rawScrollTop: 5166,
          bottomScrollTop: 5013,
          domMaxScrollTop: 5166,
        }),
      ).toEqual({ action: "clamp", scrollTop: 5013 });
    });

    it("keeps native scroll inside cursor-aware bottom", () => {
      expect(
        decideCursorAwareClamp({
          rawScrollTop: 4900,
          bottomScrollTop: 5013,
          domMaxScrollTop: 5166,
        }),
      ).toEqual({ action: "keep", scrollTop: 4900 });
    });

    it("keeps native scroll when DOM bottom and cursor-aware bottom are the same boundary", () => {
      expect(
        decideCursorAwareClamp({
          rawScrollTop: 5166,
          bottomScrollTop: 5166,
          domMaxScrollTop: 5166,
        }),
      ).toEqual({ action: "keep", scrollTop: 5166 });
    });
  });

  describe("decideTouchMoveBoundary", () => {
    it("prevents finger-up native overscroll at cursor-aware bottom", () => {
      expect(
        decideTouchMoveBoundary({
          previousClientY: 320,
          currentClientY: 280,
          scrollTop: 7593,
          bottomScrollTop: 7593,
          domMaxScrollTop: 7746,
          atBottom: true,
        }),
      ).toEqual({ action: "prevent", scrollTop: 7593 });
    });

    it("prevents a finger-up move that would cross into the cursor-aware bottom gap", () => {
      expect(
        decideTouchMoveBoundary({
          previousClientY: 320,
          currentClientY: 300,
          scrollTop: 8605,
          bottomScrollTop: 8613,
          domMaxScrollTop: 8766,
          atBottom: false,
        }),
      ).toEqual({ action: "prevent", scrollTop: 8613 });
    });

    it("allows finger-down movement away from cursor-aware bottom", () => {
      expect(
        decideTouchMoveBoundary({
          previousClientY: 280,
          currentClientY: 320,
          scrollTop: 7593,
          bottomScrollTop: 7593,
          domMaxScrollTop: 7746,
          atBottom: true,
        }),
      ).toEqual({ action: "allow" });
    });

    it("allows finger-up movement before reaching cursor-aware bottom", () => {
      expect(
        decideTouchMoveBoundary({
          previousClientY: 320,
          currentClientY: 280,
          scrollTop: 7300,
          bottomScrollTop: 7593,
          domMaxScrollTop: 7746,
          atBottom: false,
        }),
      ).toEqual({ action: "allow" });
    });

    it("allows movement when the current platform does not expose a cursor-aware bottom gap", () => {
      expect(
        decideTouchMoveBoundary({
          previousClientY: 320,
          currentClientY: 280,
          scrollTop: 7746,
          bottomScrollTop: 7746,
          domMaxScrollTop: 7746,
          atBottom: true,
        }),
      ).toEqual({ action: "allow" });
    });
  });
});
