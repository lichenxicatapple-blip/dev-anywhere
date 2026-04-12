import type { ProxyInfo } from "@cc-anywhere/shared";

// 冷启动导航决策：根据 Storage 状态和 proxy 列表决定跳转目标
// 返回 null 表示留在 proxy-select，否则返回匹配的 proxy 和跳转 URL
export function resolveColdStart(
  savedProxyId: string,
  savedSessionId: string,
  proxies: ProxyInfo[],
  savedSessionMode?: string,
): { proxy: ProxyInfo; url: string } | null {
  if (!savedProxyId) return null;

  const onlineProxy = proxies.find((p) => p.proxyId === savedProxyId && p.online);
  if (!onlineProxy) return null;

  const mode = savedSessionMode || "json";
  const url = savedSessionId
    ? `/pages/chat/index?sessionId=${savedSessionId}&mode=${mode}`
    : "/pages/session-list/index";

  return { proxy: onlineProxy, url };
}
