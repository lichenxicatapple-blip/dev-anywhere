import { useEffect, useRef } from "react";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";

interface PtyAutoEnterApprovalOptions {
  sessionId: string;
  enabled: boolean;
  waiting: boolean;
  sendRawInput?: (sessionId: string, data: string) => void;
}

export function usePtyAutoEnterApproval({
  sessionId,
  enabled,
  waiting,
  sendRawInput = sendRemoteInputRaw,
}: PtyAutoEnterApprovalOptions): void {
  const sentForCurrentApprovalRef = useRef(false);
  const previousSessionIdRef = useRef(sessionId);

  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      sentForCurrentApprovalRef.current = false;
    }

    if (!waiting) {
      sentForCurrentApprovalRef.current = false;
      return;
    }

    if (!enabled || sentForCurrentApprovalRef.current) return;
    sentForCurrentApprovalRef.current = true;
    sendRawInput(sessionId, "\r");
  }, [enabled, sendRawInput, sessionId, waiting]);
}
