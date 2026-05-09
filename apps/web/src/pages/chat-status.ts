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
