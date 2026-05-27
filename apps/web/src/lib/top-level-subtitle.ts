type TopLevelRoute = "proxy-select" | "sessions";
type TopLevelSurface = "desktop" | "mobile";
type RelayClientAuthIssue = "missing_client_token" | "invalid_client_token" | null;

interface TopLevelSubtitleInput {
  route: TopLevelRoute;
  surface: TopLevelSurface;
  proxiesLength: number;
  hasProxy: boolean;
  sessionCount: number;
  relayClientAuthIssue?: RelayClientAuthIssue;
}

export function getTopLevelSubtitle({
  route,
  surface,
  proxiesLength,
  hasProxy,
  sessionCount,
  relayClientAuthIssue = null,
}: TopLevelSubtitleInput): string {
  if (relayClientAuthIssue === "missing_client_token") {
    return "Relay 服务器需要 client token。请在设置里填写。";
  }
  if (relayClientAuthIssue === "invalid_client_token") {
    return "当前浏览器保存的 client token 无效或已过期。请在设置里更新。";
  }
  if (proxiesLength === 0) return "在开发机上启动 DEV Anywhere，本页会显示可连接的开发机。";
  if (surface === "mobile" && route === "proxy-select") return "选择要连接的开发机。";
  if (!hasProxy) return "选择要连接的开发机。";
  if (sessionCount === 0) return "还没有会话。可以从本地终端接入，也可以新建会话。";
  if (surface === "desktop") return "从左侧打开会话，或新建会话开始新的任务。";
  return "打开会话，或新建会话开始新的任务。";
}
