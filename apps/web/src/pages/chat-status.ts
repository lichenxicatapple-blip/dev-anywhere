import type { AgentStatusPayload, SessionInfo } from "@dev-anywhere/shared";
import type { StatusLineState } from "@/components/chat/status-line";

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
  hasPendingApproval: boolean;
}): StatusLineState {
  if (!options.connected || !options.proxyOnline) return "disconnected";
  if (options.routeSessionEnded || options.session?.state === "terminated") return "terminated";
  if (
    options.hasPendingApproval ||
    agentStatusToStatusLineState(options.agentStatus) === "waiting_approval" ||
    options.session?.state === "waiting_approval"
  ) {
    return "waiting_approval";
  }
  if (
    agentStatusToStatusLineState(options.agentStatus) === "working" ||
    options.session?.state === "working"
  ) {
    return "working";
  }
  return "idle";
}

function agentStatusToStatusLineState(
  status: AgentStatusPayload | undefined,
): Extract<StatusLineState, "idle" | "working" | "waiting_approval"> | null {
  switch (status?.phase) {
    case "waiting_permission":
      return "waiting_approval";
    case "thinking":
    case "tool_use":
    case "outputting":
      return "working";
    case "idle":
      return "idle";
    default:
      return null;
  }
}
