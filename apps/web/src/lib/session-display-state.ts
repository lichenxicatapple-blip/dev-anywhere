import type { AgentStatusPayload, PtyStatePayload, SessionInfo } from "@dev-anywhere/shared";

type SessionDisplayState = "idle" | "working" | "waiting_approval" | "terminated" | "disconnected";

export function resolveSessionDisplayState(options: {
  connected?: boolean;
  proxyOnline?: boolean;
  routeSessionEnded?: boolean;
  session: SessionInfo | undefined;
  agentStatus: AgentStatusPayload | undefined;
  ptyState: PtyStatePayload | undefined;
  hasPendingApproval?: boolean;
}): SessionDisplayState {
  if (options.connected === false || options.proxyOnline === false) return "disconnected";
  if (options.routeSessionEnded || options.session?.state === "terminated") return "terminated";
  if (
    options.hasPendingApproval ||
    options.ptyState?.state === "approval_wait" ||
    options.agentStatus?.phase === "waiting_permission" ||
    options.session?.state === "waiting_approval"
  ) {
    return "waiting_approval";
  }
  if (
    options.agentStatus?.phase === "thinking" ||
    options.agentStatus?.phase === "tool_use" ||
    options.agentStatus?.phase === "outputting" ||
    options.ptyState?.state === "working" ||
    options.ptyState?.state === "mid_pause" ||
    options.session?.state === "working"
  ) {
    return "working";
  }
  return "idle";
}

export function applyDisplayStateToSession(
  session: SessionInfo,
  displayState: SessionDisplayState,
): SessionInfo {
  if (session.state === "terminated" || session.mode !== "pty") return session;
  if (
    displayState === "idle" ||
    displayState === "working" ||
    displayState === "waiting_approval" ||
    displayState === "terminated"
  ) {
    return session.state === displayState ? session : { ...session, state: displayState };
  }
  return session;
}
