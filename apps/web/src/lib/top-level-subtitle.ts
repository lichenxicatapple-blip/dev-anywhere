type TopLevelRoute = "proxy-select" | "sessions";
type TopLevelSurface = "desktop" | "mobile";
type RelayClientAuthIssue = "missing_client_token" | "invalid_client_token" | null;

interface TopLevelSubtitleInput {
  route: TopLevelRoute;
  surface: TopLevelSurface;
  proxiesLength: number;
  proxyListLoaded: boolean;
  hasProxy: boolean;
  sessionCount: number;
  relayClientAuthIssue?: RelayClientAuthIssue;
}

export function getTopLevelSubtitle({
  route,
  surface,
  proxiesLength,
  proxyListLoaded,
  hasProxy,
  relayClientAuthIssue = null,
}: TopLevelSubtitleInput): string | null {
  if (relayClientAuthIssue === "missing_client_token") {
    return "Relay 需要 client token，请在设置中填写";
  }
  if (relayClientAuthIssue === "invalid_client_token") {
    return "client token 无效或已过期，请在设置中更新";
  }
  if (!proxyListLoaded) return null;
  if (proxiesLength === 0) return "在开发机上启动 DEV Anywhere，本页会显示可连接的开发机";
  if (surface === "mobile" && route === "proxy-select") return "选择要连接的开发机";
  if (!hasProxy) return "选择要连接的开发机";
  return null;
}
