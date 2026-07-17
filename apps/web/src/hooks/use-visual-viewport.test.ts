import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeVisualViewportBottomOffset,
  computeVisualViewportLayoutBottomInset,
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

  it("detects an Android keyboard when Chrome pans the visual viewport", () => {
    expect(
      computeVisualViewportBottomOffset({
        layoutViewportHeight: 789,
        visualViewportHeight: 477,
        visualViewportOffsetTop: 312,
        baselineViewportHeight: 789,
        subtractVisualViewportOffsetTop: false,
      }),
    ).toBe(312);
  });
});

describe("computeVisualViewportLayoutBottomInset", () => {
  it("tracks a small Android viewport pan after the keyboard is already confirmed open", () => {
    expect(
      computeVisualViewportLayoutBottomInset({
        layoutViewportHeight: 789,
        visualViewportHeight: 477,
        visualViewportOffsetTop: 258,
        softKeyboardOpen: true,
      }),
    ).toBe(54);
  });

  it("still ignores the same small inset when no keyboard is open", () => {
    expect(
      computeVisualViewportLayoutBottomInset({
        layoutViewportHeight: 789,
        visualViewportHeight: 477,
        visualViewportOffsetTop: 258,
      }),
    ).toBe(0);
  });

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

  it("uses the pre-focus baseline during the iPadOS keyboard transition", () => {
    expect(
      computeVisualViewportLayoutBottomInset({
        layoutViewportHeight: 460,
        visualViewportHeight: 460,
        visualViewportOffsetTop: 0,
        baselineViewportHeight: 800,
        allowBaselineFallback: true,
      }),
    ).toBe(340);
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
