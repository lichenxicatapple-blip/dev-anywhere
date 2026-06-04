import { describe, expect, it } from "vitest";
import { describeClientDevice, formatClientDeviceLabel } from "./client-device";

describe("client device descriptor", () => {
  it("identifies iPadOS Safari desktop mode from browser environment hints", () => {
    const descriptor = describeClientDevice({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });

    expect(descriptor).toMatchObject({
      browserName: "Safari",
      osName: "iPad",
      deviceKind: "tablet",
    });
    expect(formatClientDeviceLabel(descriptor)).toBe("Safari · iPad");
  });

  it("preserves explicit descriptor fields", () => {
    const descriptor = describeClientDevice({
      browserName: "Safari",
      osName: "iPad",
      deviceKind: "tablet",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });

    expect(descriptor).toMatchObject({
      browserName: "Safari",
      osName: "iPad",
      deviceKind: "tablet",
    });
  });
});
