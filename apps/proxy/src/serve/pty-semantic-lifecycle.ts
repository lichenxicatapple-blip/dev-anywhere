import { SessionState, type PtySemanticState } from "@dev-anywhere/shared";

export function resolvePtySemanticSessionTransitions(
  currentState: SessionState | undefined,
  semanticState: PtySemanticState,
): SessionState[] {
  if (semanticState !== "turn_complete") return [];

  if (currentState === SessionState.WAITING_APPROVAL) {
    return [SessionState.IDLE];
  }

  if (currentState === SessionState.WORKING) {
    return [SessionState.IDLE];
  }

  return [];
}
