import { beforeEach, describe, expect, it } from "vitest";
import { useVoicePilotStore, type VoicePilotState } from "./voice-pilot-store";

function state(sessionId = "s1"): VoicePilotState {
  return useVoicePilotStore.getState().bySessionId[sessionId]!;
}

describe("voice pilot store", () => {
  beforeEach(() => {
    useVoicePilotStore.getState().resetAll();
  });

  it("enables a session in starting state and disables it back to idle", () => {
    useVoicePilotStore.getState().enable("s1");

    expect(state()).toMatchObject({
      enabled: true,
      phase: "starting",
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

  it("keeps last spoken text across runtime state changes", () => {
    useVoicePilotStore.getState().enable("s1");
    useVoicePilotStore.getState().setLastSpokenText("s1", "上一条播报");
    useVoicePilotStore.getState().setPhase("s1", "waiting");
    useVoicePilotStore.getState().setPhase("s1", "listening");

    expect(state().lastSpokenText).toBe("上一条播报");
    expect(state().phase).toBe("listening");
  });

  it("tracks the active approval request and clears it on disable", () => {
    useVoicePilotStore.getState().enable("s1");
    useVoicePilotStore.getState().setApproval("s1", "toolu_1");

    expect(state()).toMatchObject({ phase: "starting", approvalRequestId: "toolu_1" });

    useVoicePilotStore.getState().disable("s1");

    expect(state()).toMatchObject({ phase: "idle", approvalRequestId: null });
  });

  it("tracks the latest activity meter sample", () => {
    useVoicePilotStore.getState().enable("s1");
    useVoicePilotStore.getState().setActivityLevel("s1", 0.42);

    expect(state()).toMatchObject({ enabled: true, phase: "starting", activityLevel: 0.42 });

    useVoicePilotStore.getState().setActivityLevel("s1", 5);
    expect(state().activityLevel).toBe(1);
  });

  it("keeps a bounded rolling PCM envelope and clears it with the session", () => {
    useVoicePilotStore.getState().enable("s1");
    const bins = Array.from({ length: 80 }, (_, index) => ({
      min: -index / 100,
      max: index / 100,
    }));

    useVoicePilotStore.getState().appendWaveform("s1", bins);
    expect(state().waveform).toHaveLength(64);
    expect(state().waveform[0]).toEqual(bins[16]);

    useVoicePilotStore.getState().clearWaveform("s1");
    expect(state().waveform).toEqual([]);
  });
});
