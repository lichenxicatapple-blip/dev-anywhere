import { useRef } from "react";
import type { AgentStatusPayload, SessionInfo } from "@dev-anywhere/shared";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { useAppStore } from "@/stores/app-store";
import { ptyAutoYesSessionKey, useSessionStore } from "@/stores/session-store";
import {
  usePtyAutoEnterApproval,
  type PtyAutoEnterApprovalHistory,
} from "./use-pty-auto-enter-approval";

type SendRawInput = (sessionId: string, data: string) => void;

interface PtyAutoYesTarget {
  key: string;
  sessionId: string;
  enabled: boolean;
  waiting: boolean;
  approvalRequestId?: string;
}

interface PtyAutoYesControllerProps {
  sendRawInput?: SendRawInput;
}

function resolveTarget(options: {
  proxyId: string | null | undefined;
  session: SessionInfo;
  agentStatus: AgentStatusPayload | undefined;
  autoYesBySessionKey: Record<string, boolean>;
  connected: boolean;
  proxyOnline: boolean;
}): PtyAutoYesTarget | null {
  if (options.session.mode !== "pty" || options.session.kind === "terminal") return null;
  // Codex's ActionRequired title also describes questions while its composer remains editable.
  // Neither that title nor a broker permission request proves an Enter-addressable native menu.
  // Until there is a reliable approval channel, never inject automatic Enter into Codex PTYs.
  if (options.session.provider === "codex") return null;
  const key = ptyAutoYesSessionKey(options.proxyId, options.session.sessionId);
  if (!key) return null;

  const canWait = !["idle", "error", "terminated"].includes(options.session.state);
  const approvalRequestId =
    options.agentStatus?.provider === options.session.provider &&
    options.agentStatus.phase === "waiting_permission"
      ? options.agentStatus.permissionRequest?.requestId
      : undefined;

  return {
    key,
    sessionId: options.session.sessionId,
    enabled: options.connected && options.proxyOnline && Boolean(options.autoYesBySessionKey[key]),
    // A retained PTY observation cannot resurrect approval after session_status resumed work.
    // Session waiting_approval remains the legacy fallback, including when it arrives first.
    waiting:
      canWait && (options.session.state === "waiting_approval" || Boolean(approvalRequestId)),
    approvalRequestId,
  };
}

function PtyAutoYesSessionController({
  target,
  sendRawInput,
  history,
}: {
  target: PtyAutoYesTarget;
  sendRawInput: SendRawInput;
  history: PtyAutoEnterApprovalHistory;
}) {
  usePtyAutoEnterApproval({
    sessionId: target.sessionId,
    enabled: target.enabled,
    waiting: target.waiting,
    approvalRequestId: target.approvalRequestId,
    approvalScopeKey: target.key,
    history,
    sendRawInput,
  });
  return null;
}

export function PtyAutoYesController({
  sendRawInput = sendRemoteInputRaw,
}: PtyAutoYesControllerProps) {
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const selectedProxyId = useAppStore((s) => s.selectedProxyId);
  const sessions = useSessionStore((s) => s.sessions);
  const agentStatusBySessionId = useSessionStore((s) => s.agentStatusBySessionId);
  const autoYesBySessionKey = useSessionStore((s) => s.ptyAutoYesBySessionKey);
  const approvalHistoryRef = useRef<PtyAutoEnterApprovalHistory>(new Map());

  const targets = sessions
    .map((session) =>
      resolveTarget({
        proxyId: selectedProxyId,
        session,
        agentStatus: agentStatusBySessionId[session.sessionId],
        autoYesBySessionKey,
        connected,
        proxyOnline,
      }),
    )
    .filter((target): target is PtyAutoYesTarget => target !== null);

  return (
    <>
      {targets.map((target) => (
        <PtyAutoYesSessionController
          key={target.key}
          target={target}
          sendRawInput={sendRawInput}
          history={approvalHistoryRef.current}
        />
      ))}
    </>
  );
}
