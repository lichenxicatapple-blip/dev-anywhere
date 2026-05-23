export function isVoicePilotAgentBusy({
  sessionState,
  agentPhase,
  ptyState,
}: {
  sessionState?: string;
  agentPhase?: string;
  ptyState?: string;
}): boolean {
  return (
    sessionState === "working" ||
    sessionState === "compacting" ||
    agentPhase === "thinking" ||
    agentPhase === "tool_use" ||
    agentPhase === "outputting" ||
    ptyState === "working"
  );
}
