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

  it("buffers ASR final text without leaving listening", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("listening");

    const result = machine.send({ type: "asrFinal", text: "帮我看报错" });

    expect(result.phase).toBe("listening");
    expect(result.effects).toEqual([{ type: "appendFinalToTurnBuffer", text: "帮我看报错" }]);
  });

  it("submits after turn idle and user-end cue", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("listening");

    expect(machine.send({ type: "turnIdleElapsed" })).toEqual({
      phase: "submitting",
      effects: [{ type: "stopCapture" }, { type: "playCue", cue: "user-end" }],
    });

    expect(machine.send({ type: "userEndCueDone", text: "嗯。", messageId: "m-uec" })).toEqual({
      phase: "waiting",
      effects: [{ type: "submitText", text: "嗯。", messageId: "m-uec" }],
    });
  });

  it("stops capture while speaking and resumes listening after playback", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("waiting");

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

  it("hydrates into summarizing phase for tests", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("summarizing");
    expect(machine.getPhase()).toBe("summarizing");
  });

  it("pauses on pauseRequested from listening", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("listening");

    expect(machine.send({ type: "pauseRequested" })).toEqual({
      phase: "paused",
      effects: [{ type: "stopCapture" }, { type: "playCue", cue: "user-end" }],
    });
  });

  it("resumes from paused on resumeRequested", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("paused");

    expect(machine.send({ type: "resumeRequested" })).toEqual({
      phase: "listening",
      effects: [{ type: "startCapture" }, { type: "playCue", cue: "user-end" }],
    });
  });

  it("cancels the in-flight turn and restarts capture on cancelTurnRequested", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("listening");

    expect(machine.send({ type: "cancelTurnRequested" })).toEqual({
      phase: "listening",
      effects: [
        { type: "cancelTurnBuffer" },
        { type: "playCue", cue: "user-end" },
        { type: "startCapture" },
      ],
    });
  });

  it("enters approval phase when approvalArrived fires", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("listening");

    expect(machine.send({ type: "approvalArrived", requestId: "toolu_1" })).toEqual({
      phase: "approval",
      effects: [
        { type: "stopCapture" },
        { type: "speakStatic", text: "请说批准这次或拒绝这次。" },
      ],
    });
  });

  it("returns to waiting on approvalResolved approve", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("approval");

    expect(
      machine.send({ type: "approvalResolved", action: "approve", requestId: "toolu_1" }),
    ).toEqual({
      phase: "waiting",
      effects: [
        { type: "approveTool", requestId: "toolu_1" },
        { type: "playCue", cue: "user-end" },
      ],
    });
  });

  it("returns to waiting on approvalResolved deny", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("approval");

    expect(
      machine.send({ type: "approvalResolved", action: "deny", requestId: "toolu_1" }),
    ).toEqual({
      phase: "waiting",
      effects: [
        { type: "denyTool", requestId: "toolu_1" },
        { type: "playCue", cue: "user-end" },
      ],
    });
  });

  it("enters summarizing on summaryRequested from waiting", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("waiting");

    expect(
      machine.send({
        type: "summaryRequested",
        text: "原始长文本",
        messageId: "m-1",
        reason: "code",
      }),
    ).toEqual({
      phase: "summarizing",
      effects: [
        { type: "stopCapture" },
        { type: "requestSummary", text: "原始长文本", messageId: "m-1", reason: "code" },
      ],
    });
  });

  it("speaks the summary text after summaryReady", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("summarizing");

    expect(machine.send({ type: "summaryReady", text: "短摘要", messageId: "m-1" })).toEqual({
      phase: "speaking",
      effects: [{ type: "speakText", text: "短摘要", messageId: "m-1" }],
    });
  });

  it("speaks the fallback text on summaryFailed", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("summarizing");

    expect(
      machine.send({ type: "summaryFailed", fallbackText: "回退文本", messageId: "m-1" }),
    ).toEqual({
      phase: "speaking",
      effects: [{ type: "speakText", text: "回退文本", messageId: "m-1" }],
    });
  });

  it("submits user text directly via userTextRecognized", () => {
    const machine = createVoicePilotSessionMachine();
    machine.hydrateReadyForTest("submitting");

    expect(
      machine.send({ type: "userTextRecognized", text: "请检查项目状态", messageId: "m-utx" }),
    ).toEqual({
      phase: "waiting",
      effects: [{ type: "submitText", text: "请检查项目状态", messageId: "m-utx" }],
    });
  });

  it("allows assistantTextReady from non-waiting phases for ad-hoc speak", () => {
    const fromListening = createVoicePilotSessionMachine();
    fromListening.hydrateReadyForTest("listening");
    expect(
      fromListening.send({ type: "assistantTextReady", text: "状态聆听中。", messageId: "" }),
    ).toEqual({
      phase: "speaking",
      effects: [
        { type: "stopCapture" },
        { type: "speakText", text: "状态聆听中。", messageId: "" },
      ],
    });

    // approval / paused 内的 speak 不切 phase, 等用户回应或保持暂停
    const fromApproval = createVoicePilotSessionMachine();
    fromApproval.hydrateReadyForTest("approval");
    expect(
      fromApproval.send({ type: "assistantTextReady", text: "审批提示。", messageId: "" }),
    ).toEqual({
      phase: "approval",
      effects: [
        { type: "stopCapture" },
        { type: "speakText", text: "审批提示。", messageId: "" },
      ],
    });

    const fromPaused = createVoicePilotSessionMachine();
    fromPaused.hydrateReadyForTest("paused");
    expect(
      fromPaused.send({ type: "assistantTextReady", text: "暂停状态播报。", messageId: "" }),
    ).toEqual({
      phase: "paused",
      effects: [{ type: "speakText", text: "暂停状态播报。", messageId: "" }],
    });
  });
});
