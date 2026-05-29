import { describe, expect, it } from "vitest";
import {
  computeVisualViewportBottomOffset,
  computeVisualViewportLayoutBottomInset,
  isTouchTabletViewport,
} from "./use-visual-viewport";

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
