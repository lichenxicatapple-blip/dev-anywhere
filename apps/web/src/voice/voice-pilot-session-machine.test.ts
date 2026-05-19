import { describe, expect, it } from "vitest";
import { createVoicePilotSessionMachine } from "./voice-pilot-session-machine";

describe("VoicePilotSessionMachine", () => {
  it("starts capture after ASR and TTS are ready", () => {
    const machine = createVoicePilotSessionMachine();

    expect(machine.send({ type: "enableRequested" })).toEqual({
      phase: "starting",
      effects: [
        { type: "loadConfig" },
        { type: "requestMicPermission" },
        { type: "requestWakeLock" },
      ],
    });
    expect(machine.send({ type: "configReady" }).effects).toEqual([]);
    expect(machine.send({ type: "micPermissionGranted" }).effects).toEqual([]);
    expect(machine.send({ type: "asrReady" }).effects).toEqual([]);

    const result = machine.send({ type: "ttsReady" });

    expect(result.phase).toBe("listening");
    expect(result.effects).toEqual([
      { type: "playCue", cue: "listening-start" },
      { type: "startCapture" },
    ]);
  });

  it("moves from listening to drafting when ASR final text arrives", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("listening");

    const result = machine.send({ type: "asrFinal", text: "帮我看报错" });

    expect(result.phase).toBe("drafting");
    expect(result.effects).toEqual([{ type: "appendFinalToTurnBuffer", text: "帮我看报错" }]);
  });

  it("submits after turn idle and user-end cue", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("drafting");

    expect(machine.send({ type: "turnIdleElapsed" })).toEqual({
      phase: "submitting",
      effects: [{ type: "stopCapture" }, { type: "playCue", cue: "user-end" }],
    });

    expect(machine.send({ type: "userEndCueDone", text: "嗯。" })).toEqual({
      phase: "waitingForAgent",
      effects: [{ type: "submitText", text: "嗯。" }],
    });
  });

  it("stops capture while speaking and resumes listening after playback", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("waitingForAgent");

    expect(
      machine.send({ type: "assistantTextReady", text: "我来处理。", messageId: "m1" }),
    ).toEqual({
      phase: "speaking",
      effects: [
        { type: "stopCapture" },
        { type: "speakText", text: "我来处理。", messageId: "m1" },
      ],
    });

    expect(machine.send({ type: "ttsFinished" })).toEqual({
      phase: "speaking",
      effects: [{ type: "playCue", cue: "assistant-end" }],
    });

    expect(machine.send({ type: "assistantEndCueDone" })).toEqual({
      phase: "listening",
      effects: [{ type: "startCapture" }],
    });
  });
});
