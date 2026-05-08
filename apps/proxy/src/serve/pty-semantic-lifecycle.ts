import { SessionState } from "@dev-anywhere/shared";
import type { PtySemanticState } from "../common/osc-extractor.js";

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
