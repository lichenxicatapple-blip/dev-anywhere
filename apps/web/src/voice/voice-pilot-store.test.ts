import { beforeEach, describe, expect, it } from "vitest";
import { useVoicePilotStore, type VoicePilotState } from "./voice-pilot-store";

function state(sessionId = "s1"): VoicePilotState {
  return useVoicePilotStore.getState().bySessionId[sessionId]!;
}

describe("voice pilot store", () => {
  beforeEach(() => {
    useVoicePilotStore.getState().resetAll();
  });

  it("enables a session in listening state and disables it back to idle", () => {
    useVoicePilotStore.getState().enable("s1");

    expect(state()).toMatchObject({
      enabled: true,
      phase: "listening",
      lastSpokenText: "",
      error: null,
    });

    useVoicePilotStore.getState().disable("s1");

    expect(state()).toMatchObject({
      enabled: false,
      phase: "idle",
      approvalRequestId: null,
    });
  });

  it("keeps last spoken text across pause and repeat-ready state changes", () => {
    useVoicePilotStore.getState().enable("s1");
    useVoicePilotStore.getState().setLastSpokenText("s1", "上一条播报");
    useVoicePilotStore.getState().setPhase("s1", "paused");
    useVoicePilotStore.getState().setPhase("s1", "listening");

    expect(state().lastSpokenText).toBe("上一条播报");
    expect(state().phase).toBe("listening");
  });

  it("tracks the active approval request and clears it on disable", () => {
    useVoicePilotStore.getState().enable("s1");
    useVoicePilotStore.getState().setApproval("s1", "toolu_1");

    expect(state()).toMatchObject({ phase: "approval", approvalRequestId: "toolu_1" });

    useVoicePilotStore.getState().disable("s1");

    expect(state()).toMatchObject({ phase: "idle", approvalRequestId: null });
  });

  it("tracks the latest activity meter sample", () => {
    useVoicePilotStore.getState().enable("s1");
    useVoicePilotStore.getState().setActivityLevel("s1", 0.42);

    expect(state()).toMatchObject({ enabled: true, phase: "listening", activityLevel: 0.42 });

    useVoicePilotStore.getState().setActivityLevel("s1", 5);
    expect(state().activityLevel).toBe(1);
  });
});
