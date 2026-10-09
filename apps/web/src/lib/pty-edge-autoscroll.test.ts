import { describe, expect, it } from "vitest";
import { createEdgeAutoscrollStepper, getEdgeAutoscrollDelta } from "./pty-edge-autoscroll";

const rect = { left: 0, top: 0, right: 320, bottom: 240 };

describe("selection autoscroll timing", () => {
  it.each([30, 60, 120])("preserves travel at %i fps, including slow edge speeds", (fps) => {
    for (const speed of [1, 13, -1, -13]) {
      const stepper = createEdgeAutoscrollStepper();
      const delta = { dx: speed, dy: -speed };
      stepper.step(delta, 0);
      let x = 0;
      let y = 0;
      for (let frame = 1; frame <= fps; frame++) {
        const step = stepper.step(delta, (frame * 1000) / fps);
        expect(Number.isInteger(step.dx) && Number.isInteger(step.dy)).toBe(true);
        x += step.dx;
        y += step.dy;
      }
      expect(Math.abs(x - speed * 60)).toBeLessThanOrEqual(1);
      expect(Math.abs(y + speed * 60)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps advancing at 5 fps while bounding each frame after a stall", () => {
    const stepper = createEdgeAutoscrollStepper();
    const delta = { dx: 0, dy: 13 };
    stepper.step(delta, 0);
    let distance = 0;
    for (let frame = 1; frame <= 10; frame++) {
      const step = stepper.step(delta, frame * 200);
      expect(step.dy).toBeLessThanOrEqual(78);
      distance += step.dy;
    }
    expect(distance).toBeGreaterThan(650);
    expect(stepper.step(delta, 62_000).dy).toBeLessThanOrEqual(78);
  });

  it("drops fractional carry when leaving an edge or reversing direction", () => {
    const stepper = createEdgeAutoscrollStepper();
    stepper.step({ dx: 0, dy: 0 }, 0);
    expect(stepper.step({ dx: 1, dy: 1 }, 5)).toEqual({ dx: 0, dy: 0 });
    expect(stepper.step({ dx: -1, dy: 0 }, 10)).toEqual({ dx: 0, dy: 0 });
    expect(stepper.step({ dx: -1, dy: 1 }, 20)).toEqual({ dx: 0, dy: 0 });
  });

  it("starts a new gesture with one frame instead of accumulating idle time", () => {
    const stepper = createEdgeAutoscrollStepper();
    stepper.step({ dx: 1, dy: -1 }, 0);
    stepper.step({ dx: 1, dy: -1 }, 5);
    stepper.reset();
    expect(stepper.step({ dx: 13, dy: -13 }, 60_000)).toEqual({ dx: 13, dy: -13 });
  });
});

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
