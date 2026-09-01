import { describe, expect, it } from "vitest";
import { devicePointerGesture, normalizedPointInDeviceFrame } from "./device-preview-pointer";

describe("normalizedPointInDeviceFrame", () => {
  it("maps portrait frames and excludes horizontal letterboxing", () => {
    const layout = {
      left: 10,
      top: 20,
      width: 500,
      height: 500,
      frameWidth: 250,
      frameHeight: 500,
    };
    expect(normalizedPointInDeviceFrame(260, 270, layout)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedPointInDeviceFrame(20, 270, layout)).toBeNull();
  });

  it("maps landscape frames and excludes vertical letterboxing", () => {
    const layout = {
      left: 0,
      top: 0,
      width: 400,
      height: 400,
      frameWidth: 800,
      frameHeight: 400,
    };
    expect(normalizedPointInDeviceFrame(200, 200, layout)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedPointInDeviceFrame(200, 20, layout)).toBeNull();
  });
});

describe("devicePointerGesture", () => {
  it("keeps small pointer movement as a tap", () => {
    expect(
      devicePointerGesture({
        start: { x: 0.4, y: 0.4 },
        end: { x: 0.41, y: 0.41 },
        startClientX: 100,
        startClientY: 100,
        endClientX: 105,
        endClientY: 104,
        durationMs: 100,
      }),
    ).toEqual({ kind: "tap", x: 0.41, y: 0.41 });
  });

  it("creates a bounded swipe for larger movement", () => {
    expect(
      devicePointerGesture({
        start: { x: 0.5, y: 0.8 },
        end: { x: 0.5, y: 0.2 },
        startClientX: 100,
        startClientY: 300,
        endClientX: 100,
        endClientY: 100,
        durationMs: 8_000,
      }),
    ).toEqual({
      kind: "swipe",
      startX: 0.5,
      startY: 0.8,
      endX: 0.5,
      endY: 0.2,
      durationMs: 5_000,
    });
  });
});
