import { describe, expect, it } from "vitest";
import { evaluateBrowserSupport } from "./browser-support";

const IPAD_CHROME_USER_AGENT =
  "Mozilla/5.0 (iPad; CPU OS 26_5_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/150.0.7871.51 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI_USER_AGENT =
  "Mozilla/5.0 (iPad; CPU OS 26_5_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/15E148 Safari/604.1";

describe("browser support", () => {
  it("requires Safari for Chrome running on iPad", () => {
    expect(
      evaluateBrowserSupport({
        userAgent: IPAD_CHROME_USER_AGENT,
        platform: "iPad",
        maxTouchPoints: 5,
      }),
    ).toEqual({
      supported: false,
      reason: "ipad-safari-required",
      browserName: "Chrome",
    });
  });

  it("allows Safari in both mobile and desktop-site modes on iPad", () => {
    expect(
      evaluateBrowserSupport({
        userAgent: IPAD_SAFARI_USER_AGENT,
        platform: "iPad",
        maxTouchPoints: 5,
      }),
    ).toEqual({ supported: true });

    expect(
      evaluateBrowserSupport({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).toEqual({ supported: true });
  });

  it("allows an installed iPad web app without relying on its browser token", () => {
    expect(
      evaluateBrowserSupport({
        userAgent: IPAD_CHROME_USER_AGENT,
        platform: "iPad",
        maxTouchPoints: 5,
        standalone: true,
      }),
    ).toEqual({ supported: true });
  });

  it("does not apply the iPad policy to Chrome on iPhone, macOS, or Android", () => {
    const chromeUserAgents = [
      {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 CriOS/150.0 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
      },
      {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0 Safari/537.36",
        platform: "MacIntel",
        maxTouchPoints: 0,
      },
      {
        userAgent:
          "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/150.0 Mobile Safari/537.36",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      },
    ];

    for (const hints of chromeUserAgents) {
      expect(evaluateBrowserSupport(hints)).toEqual({ supported: true });
    }
  });

  it("blocks another identifiable third-party browser on iPad", () => {
    expect(
      evaluateBrowserSupport({
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/150.0 Mobile/15E148 Safari/605.1.15",
        platform: "iPad",
        maxTouchPoints: 5,
      }),
    ).toMatchObject({ supported: false, browserName: "Edge" });
  });

  it("blocks an unknown iPad webview instead of assuming every Safari token is Safari", () => {
    expect(
      evaluateBrowserSupport({
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
        platform: "iPad",
        maxTouchPoints: 5,
      }),
    ).toMatchObject({ supported: false, browserName: "浏览器" });
  });
});
