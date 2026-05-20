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
    agentPhase === "thinking" ||
    agentPhase === "tool_use" ||
    agentPhase === "outputting" ||
    ptyState === "working"
  );
}
