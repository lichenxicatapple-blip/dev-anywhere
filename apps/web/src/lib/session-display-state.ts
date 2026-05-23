import type { AgentStatusPayload, PtyStatePayload, SessionInfo } from "@dev-anywhere/shared";

type SessionDisplayState =
  | "idle"
  | "working"
  | "compacting"
  | "waiting_approval"
  | "terminated"
  | "disconnected";

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
  if (options.hasPendingApproval || options.session?.state === "waiting_approval") {
    return "waiting_approval";
  }
  if (options.session?.state === "compacting") return "compacting";
  if (options.session?.state === "working") return "working";
  if (options.session?.state === "idle") return "idle";
  if (options.agentStatus?.phase === "waiting_permission") return "waiting_approval";
  if (options.ptyState?.state === "approval_wait") return "waiting_approval";
  if (
    options.agentStatus?.phase === "thinking" ||
    options.agentStatus?.phase === "tool_use" ||
    options.agentStatus?.phase === "outputting" ||
    options.ptyState?.state === "working"
  )
    return "working";
  return "idle";
}
