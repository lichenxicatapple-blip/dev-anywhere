import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeVisualViewportBottomOffset,
  computeVisualViewportLayoutBottomInset,
  isTouchTabletViewport,
  resetDocumentScrollIfNeeded,
} from "./use-visual-viewport";

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  document.documentElement.scrollLeft = 0;
  document.documentElement.scrollTop = 0;
  document.body.scrollLeft = 0;
  document.body.scrollTop = 0;
});

describe("computeVisualViewportBottomOffset", () => {
  it("returns 0 when the visual viewport matches the layout viewport", () => {
    expect(
      computeVisualViewportBottomOffset({
        layoutViewportHeight: 800,
        visualViewportHeight: 800,
        visualViewportOffsetTop: 0,
        baselineViewportHeight: 800,
      }),
    ).toBe(0);
  });

  it("returns the bottom inset when the soft keyboard only shrinks visualViewport", () => {
    expect(
      computeVisualViewportBottomOffset({
        layoutViewportHeight: 800,
        visualViewportHeight: 460,
        visualViewportOffsetTop: 0,
        baselineViewportHeight: 800,
      }),
    ).toBe(340);
  });

  it("keeps browser chrome viewport changes from creating keyboard padding", () => {
    expect(
      computeVisualViewportBottomOffset({
        layoutViewportHeight: 800,
        visualViewportHeight: 688,
        visualViewportOffsetTop: 0,
        baselineViewportHeight: 800,
      }),
    ).toBe(0);
  });

  it("uses the pre-keyboard baseline when Android also shrinks innerHeight", () => {
    expect(
      computeVisualViewportBottomOffset({
        layoutViewportHeight: 480,
        visualViewportHeight: 480,
        visualViewportOffsetTop: 0,
        baselineViewportHeight: 800,
      }),
    ).toBe(320);
  });

  it("can disable baseline fallback for iOS browser UI changes", () => {
    expect(
      computeVisualViewportBottomOffset({
        layoutViewportHeight: 480,
        visualViewportHeight: 480,
        visualViewportOffsetTop: 0,
        baselineViewportHeight: 800,
        allowBaselineFallback: false,
      }),
    ).toBe(0);
  });

  it("still detects real iOS soft-keyboard compression without baseline fallback", () => {
    expect(
      computeVisualViewportBottomOffset({
        layoutViewportHeight: 800,
        visualViewportHeight: 460,
        visualViewportOffsetTop: 0,
        baselineViewportHeight: 800,
        allowBaselineFallback: false,
      }),
    ).toBe(340);
  });

  it("subtracts visualViewport offsetTop from the keyboard inset", () => {
    expect(
      computeVisualViewportBottomOffset({
        layoutViewportHeight: 800,
        visualViewportHeight: 460,
        visualViewportOffsetTop: 20,
        baselineViewportHeight: 800,
      }),
    ).toBe(320);
  });
});

describe("computeVisualViewportLayoutBottomInset", () => {
  it("returns the current inset when the keyboard overlays the layout viewport", () => {
    expect(
      computeVisualViewportLayoutBottomInset({
        layoutViewportHeight: 800,
        visualViewportHeight: 460,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(340);
  });

  it("returns 0 when Android already resized the layout viewport", () => {
    expect(
      computeVisualViewportLayoutBottomInset({
        layoutViewportHeight: 480,
        visualViewportHeight: 480,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(0);
  });

  it("ignores small browser chrome viewport changes", () => {
    expect(
      computeVisualViewportLayoutBottomInset({
        layoutViewportHeight: 800,
        visualViewportHeight: 688,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(0);
  });
});

describe("isTouchTabletViewport", () => {
  it("detects touch tablet portrait and landscape layouts", () => {
    expect(isTouchTabletViewport({ width: 1024, height: 768, maxTouchPoints: 5 })).toBe(true);
    expect(isTouchTabletViewport({ width: 768, height: 1024, maxTouchPoints: 5 })).toBe(true);
  });

  it("does not treat phones or non-touch desktop viewports as touch tablets", () => {
    expect(isTouchTabletViewport({ width: 844, height: 390, maxTouchPoints: 5 })).toBe(false);
    expect(isTouchTabletViewport({ width: 1280, height: 800, maxTouchPoints: 0 })).toBe(false);
  });
});

describe("resetDocumentScrollIfNeeded", () => {
  it("locks app-level document scroll back to the origin", () => {
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 156 });
    document.documentElement.scrollTop = 42;
    document.body.scrollTop = 24;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    expect(resetDocumentScrollIfNeeded()).toBe(true);

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
  });

  it("does nothing when the document is already locked at the origin", () => {
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    expect(resetDocumentScrollIfNeeded()).toBe(false);

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
