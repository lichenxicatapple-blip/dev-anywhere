import { SessionState } from "@dev-anywhere/shared";
import type { SessionInfo } from "./session-manager.js";

export function shouldPromotePtyActivityToWorking(
  session: SessionInfo | undefined,
  pendingApprovalCount: number,
): boolean {
  if (!session || session.mode !== "pty") return false;
  if (pendingApprovalCount > 0) return false;
  return session.state === SessionState.IDLE || session.state === SessionState.WAITING_APPROVAL;
}
