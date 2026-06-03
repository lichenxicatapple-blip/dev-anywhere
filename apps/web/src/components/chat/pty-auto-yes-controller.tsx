import type { AgentStatusPayload, PtyStatePayload, SessionInfo } from "@dev-anywhere/shared";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { useAppStore } from "@/stores/app-store";
import { ptyAutoYesSessionKey, useSessionStore } from "@/stores/session-store";
import { usePtyAutoEnterApproval } from "./use-pty-auto-enter-approval";

type SendRawInput = (sessionId: string, data: string) => void;

interface PtyAutoYesTarget {
  key: string;
  sessionId: string;
  waiting: boolean;
  approvalSeq?: number;
}

interface PtyAutoYesControllerProps {
  sendRawInput?: SendRawInput;
}

function resolveTarget(options: {
  proxyId: string | null | undefined;
  session: SessionInfo;
  ptyState: PtyStatePayload | undefined;
  agentStatus: AgentStatusPayload | undefined;
  autoYesBySessionKey: Record<string, boolean>;
  connected: boolean;
  proxyOnline: boolean;
}): PtyAutoYesTarget | null {
  if (!options.connected || !options.proxyOnline) return null;
  if (options.session.mode !== "pty" || options.session.kind === "terminal") return null;
  if (
    options.session.state === "idle" ||
    options.session.state === "error" ||
    options.session.state === "terminated"
  ) {
    return null;
  }
  const key = ptyAutoYesSessionKey(options.proxyId, options.session.sessionId);
  if (!key || !options.autoYesBySessionKey[key]) return null;

  const waiting =
    options.session.state === "waiting_approval" ||
    options.agentStatus?.phase === "waiting_permission" ||
    options.ptyState?.state === "approval_wait";
  if (!waiting) return null;

  return {
    key,
    sessionId: options.session.sessionId,
    waiting: true,
    approvalSeq: options.ptyState?.state === "approval_wait" ? options.ptyState.seq : undefined,
  };
}

function PtyAutoYesSessionController({
  target,
  sendRawInput,
}: {
  target: PtyAutoYesTarget;
  sendRawInput: SendRawInput;
}) {
  usePtyAutoEnterApproval({
    sessionId: target.sessionId,
    enabled: true,
    waiting: target.waiting,
    approvalSeq: target.approvalSeq,
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
  const ptyStateBySessionId = useSessionStore((s) => s.ptyStateBySessionId);
  const agentStatusBySessionId = useSessionStore((s) => s.agentStatusBySessionId);
  const autoYesBySessionKey = useSessionStore((s) => s.ptyAutoYesBySessionKey);

  const targets = sessions
    .map((session) =>
      resolveTarget({
        proxyId: selectedProxyId,
        session,
        ptyState: ptyStateBySessionId[session.sessionId],
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
        />
      ))}
    </>
  );
}
