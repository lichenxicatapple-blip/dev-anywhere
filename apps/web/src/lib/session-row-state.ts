import type { AgentStatusPayload, PtyStatePayload, SessionInfo } from "@dev-anywhere/shared";
import { resolveSessionDisplayState } from "./session-display-state";

export function resolveSessionRowState(options: {
  session: SessionInfo;
  agentStatus: AgentStatusPayload | undefined;
  ptyState: PtyStatePayload | undefined;
  hasPendingApproval: boolean;
}): SessionInfo["state"] {
  if (options.session.state === "error") return "error";

  const state = resolveSessionDisplayState(options);
  if (state === "disconnected") return options.session.state;
  return state;
}
