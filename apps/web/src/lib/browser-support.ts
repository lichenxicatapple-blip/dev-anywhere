import { describeClientDevice, type ClientDeviceHints } from "./client-device";

export interface BrowserSupportHints extends ClientDeviceHints {
  standalone?: boolean;
}

export type BrowserSupportDecision =
  | { supported: true }
  | {
      supported: false;
      reason: "ipad-safari-required";
      browserName: string;
    };

export function evaluateBrowserSupport(hints: BrowserSupportHints): BrowserSupportDecision {
  const device = describeClientDevice(hints);
  if (device.osName !== "iPad") return { supported: true };
  if (hints.standalone || device.browserName === "Safari") return { supported: true };

  return {
    supported: false,
    reason: "ipad-safari-required",
    browserName: device.browserName,
  };
}

export function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const mediaStandalone =
    typeof window.matchMedia === "function" &&
    (window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches);
  const navigatorStandalone = Boolean(
    (navigator as Navigator & { standalone?: boolean }).standalone,
  );
  return mediaStandalone || navigatorStandalone;
}

export function evaluateCurrentBrowserSupport(): BrowserSupportDecision {
  if (typeof navigator === "undefined") return { supported: true };
  return evaluateBrowserSupport({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: isStandaloneDisplayMode(),
  });
}
