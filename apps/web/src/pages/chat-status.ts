import type { AgentStatusPayload, PtyStatePayload, SessionInfo } from "@dev-anywhere/shared";
import type { StatusLineState } from "@/components/chat/status-line";
import { resolveSessionDisplayState } from "@/lib/session-display-state";

export function isRouteSessionEnded(
  session: SessionInfo | undefined,
  sessionListLoaded: boolean,
): boolean {
  return sessionListLoaded && !session;
}

export function resolveChatStatusState(options: {
  connected: boolean;
  proxyOnline: boolean;
  routeSessionEnded: boolean;
  session: SessionInfo | undefined;
  agentStatus: AgentStatusPayload | undefined;
  ptyState: PtyStatePayload | undefined;
  hasPendingApproval: boolean;
}): StatusLineState {
  return resolveSessionDisplayState(options);
}

// 决定 chat 主体区域要不要被占位面板替代。
// 优先级: relay 断 > proxy 离线 > session 终止 > 正常内容。
// !connected 时 proxy / session 状态不可信, 不能向下推断。
type ChatPresentation = "ok" | "relay-disconnected" | "proxy-offline" | "session-ended";

export function resolveChatPresentation(opts: {
  connected: boolean;
  proxyOnline: boolean;
  routeSessionEnded: boolean;
}): ChatPresentation {
  if (!opts.connected) return "relay-disconnected";
  if (!opts.proxyOnline) return "proxy-offline";
  if (opts.routeSessionEnded) return "session-ended";
  return "ok";
}

export function shouldShowPtyApprovalHint(opts: {
  ptyWaitingApproval: boolean;
  ptyAutoYesEnabled: boolean;
}): boolean {
  return opts.ptyWaitingApproval && !opts.ptyAutoYesEnabled;
}
