// 移动端浏览器 / PWA 在息屏后被系统回收, 唤醒会冷启动到 manifest start_url ("/"),
// 丢失停在 /chat/<id> 的位置, 用户被甩回 session 选择页。
// 把最近一次进入的 chat 路由持久化到 localStorage; 冷启动落地 "/" 时若有记录就 replace
// 过去, 让用户的"接着上次继续"成立。sessionStorage 标记防止 SPA 内重复 restore: 用户
// 主动点回首页时不应被自动跳走。

const LAST_CHAT_ROUTE_KEY = "dev-anywhere:last-chat-route";
const RESTORED_FLAG_KEY = "dev-anywhere:route-restored";

// 决定是否要从 lastRoute 恢复。纯函数, 方便单测覆盖所有路径组合。
export function pickRouteToRestore(opts: {
  pathname: string;
  alreadyRestored: boolean;
  lastRoute: string | null;
}): string | null {
  if (opts.alreadyRestored) return null;
  if (opts.pathname !== "/") return null;
  if (!opts.lastRoute) return null;
  if (!opts.lastRoute.startsWith("/chat/")) return null;
  return opts.lastRoute;
}

export function readLastChatRoute(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_CHAT_ROUTE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeLastChatRoute(route: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_CHAT_ROUTE_KEY, route);
  } catch {
    // localStorage 不可用 (隐私模式 / quota) 时静默忽略, 损失只是下次启动不能续上
  }
}

// 清除上次记录: session 终止 / 自然消失时调用, 否则下次冷启动会跳到一个已经死掉的
// 会话再被 ChatPage 翻译为 TerminatedSessionPanel, 等于让用户多走一步。
export function clearLastChatRoute(): void {
  try {
    globalThis.localStorage?.removeItem(LAST_CHAT_ROUTE_KEY);
  } catch {
    // 同上
  }
}

export function hasRestoredThisSession(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(RESTORED_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function markRestoredThisSession(): void {
  try {
    globalThis.sessionStorage?.setItem(RESTORED_FLAG_KEY, "1");
  } catch {
    // 同上
  }
}
