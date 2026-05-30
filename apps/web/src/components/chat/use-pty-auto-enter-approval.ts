import { useEffect, useRef } from "react";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";

const WAITING_STATE_FALLBACK_SEQ = -1;

interface PtyAutoEnterApprovalOptions {
  sessionId: string;
  enabled: boolean;
  waiting: boolean;
  approvalSeq?: number;
  sendRawInput?: (sessionId: string, data: string) => void;
}

export function usePtyAutoEnterApproval({
  sessionId,
  enabled,
  waiting,
  approvalSeq,
  sendRawInput = sendRemoteInputRaw,
}: PtyAutoEnterApprovalOptions): void {
  const sentSeqRef = useRef<number | undefined>(undefined);
  const previousSessionIdRef = useRef(sessionId);

  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      sentSeqRef.current = undefined;
    }

    if (!waiting) {
      sentSeqRef.current = undefined;
      return;
    }

    if (!enabled) return;

    if (approvalSeq === undefined) {
      if (sentSeqRef.current !== undefined) return;
      sentSeqRef.current = WAITING_STATE_FALLBACK_SEQ;
      sendRawInput(sessionId, "\r");
      return;
    }

    // Some paths publish session_status before the matching pty_state. Treat the
    // first concrete seq after that fallback as the same approval window.
    if (sentSeqRef.current === WAITING_STATE_FALLBACK_SEQ) {
      sentSeqRef.current = approvalSeq;
      return;
    }
    if (sentSeqRef.current === approvalSeq) return;
    sentSeqRef.current = approvalSeq;
    sendRawInput(sessionId, "\r");
  }, [approvalSeq, enabled, sendRawInput, sessionId, waiting]);
}
