import { describe, expect, it } from "vitest";
import { clampedPointInDeviceFrame, normalizedPointInDeviceFrame } from "./device-preview-pointer";

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

  it("clamps a captured pointer after it leaves the frame", () => {
    const layout = {
      left: 20,
      top: 30,
      width: 200,
      height: 400,
      frameWidth: 100,
      frameHeight: 200,
    };

    expect(clampedPointInDeviceFrame(-500, 600, layout)).toEqual({ x: 0, y: 1 });
  });
});
