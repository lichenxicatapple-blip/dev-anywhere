import { useEffect, useRef } from "react";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";

interface ApprovalWindow {
  sent: boolean;
  confirmedRequestId?: string;
  confirmedRequestIds: Set<string>;
}

export type PtyAutoEnterApprovalHistory = Map<string, ApprovalWindow>;

interface PtyAutoEnterApprovalOptions {
  sessionId: string;
  enabled: boolean;
  waiting: boolean;
  // PTY sequence numbers count observations/output, not distinct permission requests.
  approvalSeq?: number;
  approvalRequestId?: string;
  approvalScopeKey?: string;
  history?: PtyAutoEnterApprovalHistory;
  sendRawInput?: (sessionId: string, data: string) => void;
}

export function usePtyAutoEnterApproval({
  sessionId,
  enabled,
  waiting,
  approvalRequestId,
  approvalScopeKey = sessionId,
  history,
  sendRawInput = sendRemoteInputRaw,
}: PtyAutoEnterApprovalOptions): void {
  const localHistoryRef = useRef<PtyAutoEnterApprovalHistory>(new Map());
  const approvalHistory = history ?? localHistoryRef.current;

  useEffect(() => {
    let approvalWindow = approvalHistory.get(approvalScopeKey);
    if (!approvalWindow) {
      approvalWindow = { sent: false, confirmedRequestIds: new Set() };
      approvalHistory.set(approvalScopeKey, approvalWindow);
    }

    if (!waiting) {
      approvalWindow.sent = false;
      approvalWindow.confirmedRequestId = undefined;
      return;
    }

    if (approvalRequestId && approvalWindow.confirmedRequestIds.has(approvalRequestId)) {
      approvalWindow.sent = true;
      approvalWindow.confirmedRequestId = approvalRequestId;
      return;
    }

    // session_status can precede the matching request identity. Associate it with the
    // fallback Enter already sent in this waiting window instead of sending another.
    if (
      approvalWindow.sent &&
      approvalRequestId &&
      approvalWindow.confirmedRequestId === undefined
    ) {
      approvalWindow.confirmedRequestId = approvalRequestId;
      approvalWindow.confirmedRequestIds.add(approvalRequestId);
      return;
    }
    if (
      approvalWindow.sent &&
      (!approvalRequestId || approvalWindow.confirmedRequestId === approvalRequestId)
    ) {
      return;
    }
    if (!enabled) return;

    approvalWindow.sent = true;
    approvalWindow.confirmedRequestId = approvalRequestId;
    if (approvalRequestId) approvalWindow.confirmedRequestIds.add(approvalRequestId);
    sendRawInput(sessionId, "\r");
  }, [
    approvalHistory,
    approvalRequestId,
    approvalScopeKey,
    enabled,
    sendRawInput,
    sessionId,
    waiting,
  ]);
}
