export type ClientDeviceKind = "desktop" | "tablet" | "phone" | "unknown";

export interface ClientDeviceHints {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

export interface ClientDeviceDescriptor extends ClientDeviceHints {
  browserName: string;
  osName: string;
  deviceKind: ClientDeviceKind;
}

type ClientDeviceDescriptorInput = ClientDeviceHints & Partial<ClientDeviceDescriptor>;

function browserNameFromUserAgent(userAgent: string): string | undefined {
  if (userAgent.includes("Edg/")) return "Edge";
  if (userAgent.includes("CriOS/") || userAgent.includes("Chrome/")) return "Chrome";
  if (userAgent.includes("FxiOS/") || userAgent.includes("Firefox/")) return "Firefox";
  if (userAgent.includes("Safari/")) return "Safari";
  return undefined;
}

function isIpadOsDesktopMode({ userAgent = "", platform, maxTouchPoints = 0 }: ClientDeviceHints) {
  return (
    platform === "MacIntel" &&
    maxTouchPoints > 1 &&
    (userAgent.includes("Mac OS X") || userAgent.includes("Macintosh"))
  );
}

function osNameFromHints(hints: ClientDeviceHints): string | undefined {
  const userAgent = hints.userAgent ?? "";
  if (isIpadOsDesktopMode(hints)) return "iPad";
  if (userAgent.includes("iPhone")) return "iPhone";
  if (userAgent.includes("iPad")) return "iPad";
  if (userAgent.includes("Mac OS X") || userAgent.includes("Macintosh")) return "macOS";
  if (userAgent.includes("Windows")) return "Windows";
  if (userAgent.includes("Android")) return "Android";
  return undefined;
}

function deviceKindFromOs(osName: string | undefined): ClientDeviceKind {
  if (osName === "iPad") return "tablet";
  if (osName === "iPhone" || osName === "Android") return "phone";
  if (osName === "macOS" || osName === "Windows") return "desktop";
  return "unknown";
}

export function describeClientDevice(hints: ClientDeviceDescriptorInput): ClientDeviceDescriptor {
  const browserName =
    hints.browserName ??
    (hints.userAgent ? browserNameFromUserAgent(hints.userAgent) : undefined) ??
    "浏览器";
  const osName = hints.osName ?? osNameFromHints(hints) ?? "未知系统";
  return {
    ...hints,
    browserName,
    osName,
    deviceKind: hints.deviceKind ?? deviceKindFromOs(osName),
  };
}

export function describeCurrentClientDevice(): ClientDeviceDescriptor {
  const nav = typeof navigator === "undefined" ? null : navigator;
  return describeClientDevice({
    ...(nav?.userAgent ? { userAgent: nav.userAgent } : {}),
    ...(nav?.platform ? { platform: nav.platform } : {}),
    ...(typeof nav?.maxTouchPoints === "number" ? { maxTouchPoints: nav.maxTouchPoints } : {}),
  });
}

export function formatClientDeviceLabel(descriptor: ClientDeviceDescriptor): string {
  return `${descriptor.browserName} · ${descriptor.osName}`;
}
