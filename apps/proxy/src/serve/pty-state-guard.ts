import { SessionState } from "@dev-anywhere/shared";
import type { SessionInfo } from "./session-manager.js";

export function shouldPromotePtyActivityToWorking(
  session: SessionInfo | undefined,
  pendingApprovalCount: number,
): boolean {
  return session?.state === SessionState.WAITING_APPROVAL && pendingApprovalCount === 0;
}
