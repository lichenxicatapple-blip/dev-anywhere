import { describe, expect, it } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import { resolvePtySemanticSessionTransitions } from "#src/serve/pty-semantic-lifecycle.js";

describe("resolvePtySemanticSessionTransitions", () => {
  it("settles normal PTY work on turn_complete", () => {
    expect(resolvePtySemanticSessionTransitions(SessionState.WORKING, "turn_complete")).toEqual([
      SessionState.IDLE,
    ]);
  });

  it("settles PTY approval directly when the provider ends the turn", () => {
    expect(
      resolvePtySemanticSessionTransitions(SessionState.WAITING_APPROVAL, "turn_complete"),
    ).toEqual([SessionState.IDLE]);
  });

  it("does not change idle sessions or non-terminal semantic states", () => {
    expect(resolvePtySemanticSessionTransitions(SessionState.IDLE, "turn_complete")).toEqual([]);
    expect(resolvePtySemanticSessionTransitions(SessionState.WORKING, "working")).toEqual([]);
    expect(resolvePtySemanticSessionTransitions(SessionState.WORKING, "mid_pause")).toEqual([]);
    expect(resolvePtySemanticSessionTransitions(SessionState.WORKING, "approval_wait")).toEqual([]);
  });
});
