import { describe, expect, it } from "vitest";
import { getEdgeAutoscrollDelta } from "./pty-edge-autoscroll";

const rect = { left: 0, top: 0, right: 320, bottom: 240 };

describe("getEdgeAutoscrollDelta", () => {
  it("scrolls toward the nearest active edge", () => {
    const delta = getEdgeAutoscrollDelta({
      pointerX: 316,
      pointerY: 236,
      rect,
      scrollLeft: 20,
      scrollTop: 20,
      scrollWidth: 800,
      scrollHeight: 900,
      clientWidth: 320,
      clientHeight: 240,
    });

    expect(delta.dx).toBeGreaterThan(0);
    expect(delta.dy).toBeGreaterThan(0);
  });

  it("scrolls back when the pointer enters the top or left edge", () => {
    const delta = getEdgeAutoscrollDelta({
      pointerX: 4,
      pointerY: 4,
      rect,
      scrollLeft: 120,
      scrollTop: 160,
      scrollWidth: 800,
      scrollHeight: 900,
      clientWidth: 320,
      clientHeight: 240,
    });

    expect(delta.dx).toBeLessThan(0);
    expect(delta.dy).toBeLessThan(0);
  });

  it("does not scroll when the container is already at the matching edge", () => {
    expect(
      getEdgeAutoscrollDelta({
        pointerX: 4,
        pointerY: 4,
        rect,
        scrollLeft: 0,
        scrollTop: 0,
        scrollWidth: 800,
        scrollHeight: 900,
        clientWidth: 320,
        clientHeight: 240,
      }),
    ).toEqual({ dx: 0, dy: 0 });

    expect(
      getEdgeAutoscrollDelta({
        pointerX: 316,
        pointerY: 236,
        rect,
        scrollLeft: 480,
        scrollTop: 660,
        scrollWidth: 800,
        scrollHeight: 900,
        clientWidth: 320,
        clientHeight: 240,
      }),
    ).toEqual({ dx: 0, dy: 0 });
  });
});
