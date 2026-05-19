import { createFSM } from "@dev-anywhere/shared";

export type VoicePilotMachinePhase =
  | "disabled"
  | "starting"
  | "listening"
  | "drafting"
  | "submitting"
  | "waitingForAgent"
  | "speaking"
  | "approval"
  | "paused"
  | "error";

export type VoicePilotEffect =
  | { type: "loadConfig" }
  | { type: "requestMicPermission" }
  | { type: "requestWakeLock" }
  | { type: "releaseWakeLock" }
  | { type: "startCapture" }
  | { type: "stopCapture" }
  | { type: "appendFinalToTurnBuffer"; text: string }
  | { type: "playCue"; cue: "listening-start" | "user-end" | "assistant-end" }
  | { type: "submitText"; text: string }
  | { type: "speakText"; text: string; messageId: string }
  | { type: "cleanup" }
  | { type: "setError"; error: string };

export type VoicePilotEvent =
  | { type: "enableRequested" }
  | { type: "disableRequested" }
  | { type: "configReady" }
  | { type: "micPermissionGranted" }
  | { type: "micPermissionDenied"; error: string }
  | { type: "asrReady" }
  | { type: "ttsReady" }
  | { type: "asrFinal"; text: string }
  | { type: "turnIdleElapsed" }
  | { type: "userEndCueDone"; text: string }
  | { type: "agentSubmitFailed"; error: string }
  | { type: "assistantTextReady"; text: string; messageId: string }
  | { type: "ttsFinished" }
  | { type: "assistantEndCueDone" }
  | { type: "providerError"; error: string };

export interface VoicePilotTransitionResult {
  phase: VoicePilotMachinePhase;
  effects: VoicePilotEffect[];
}

interface Readiness {
  config: boolean;
  mic: boolean;
  asr: boolean;
  tts: boolean;
}

const VOICE_PILOT_TRANSITIONS: Record<VoicePilotMachinePhase, readonly VoicePilotMachinePhase[]> = {
  disabled: ["starting"],
  starting: ["listening", "error", "disabled"],
  listening: ["drafting", "speaking", "approval", "paused", "error", "disabled"],
  drafting: ["submitting", "paused", "error", "disabled"],
  submitting: ["waitingForAgent", "error", "disabled"],
  waitingForAgent: ["speaking", "approval", "error", "disabled"],
  speaking: ["listening", "error", "disabled"],
  approval: ["waitingForAgent", "speaking", "error", "disabled"],
  paused: ["listening", "error", "disabled"],
  error: ["disabled"],
};

export interface VoicePilotSessionMachine {
  send(event: VoicePilotEvent): VoicePilotTransitionResult;
  getPhase(): VoicePilotMachinePhase;
  hydrateReadyForTest(phase: VoicePilotMachinePhase): void;
}

export function createVoicePilotSessionMachine(): VoicePilotSessionMachine {
  let fsm = createFSM<VoicePilotMachinePhase>({
    initial: "disabled",
    transitions: VOICE_PILOT_TRANSITIONS,
  });
  let readiness: Readiness = { config: false, mic: false, asr: false, tts: false };

  function result(effects: VoicePilotEffect[] = []): VoicePilotTransitionResult {
    return { phase: fsm.current(), effects };
  }

  function transitionTo(phase: VoicePilotMachinePhase): void {
    if (fsm.is(phase)) return;
    fsm.transitionTo(phase);
  }

  function maybeEnterListening(): VoicePilotTransitionResult {
    if (!fsm.is("starting")) return result();
    if (!readiness.config || !readiness.mic || !readiness.asr || !readiness.tts) return result();
    transitionTo("listening");
    return result([{ type: "playCue", cue: "listening-start" }, { type: "startCapture" }]);
  }

  return {
    getPhase: () => fsm.current(),

    hydrateReadyForTest(nextPhase) {
      fsm = createFSM<VoicePilotMachinePhase>({
        initial: nextPhase,
        transitions: VOICE_PILOT_TRANSITIONS,
      });
      readiness = { config: true, mic: true, asr: true, tts: true };
    },

    send(event): VoicePilotTransitionResult {
      if (event.type === "disableRequested") {
        transitionTo("disabled");
        readiness = { config: false, mic: false, asr: false, tts: false };
        return result([{ type: "stopCapture" }, { type: "releaseWakeLock" }, { type: "cleanup" }]);
      }

      if (event.type === "providerError") {
        transitionTo("error");
        return result([{ type: "stopCapture" }, { type: "setError", error: event.error }]);
      }

      if (event.type === "enableRequested" && fsm.is("disabled")) {
        transitionTo("starting");
        readiness = { config: false, mic: false, asr: false, tts: false };
        return result([
          { type: "loadConfig" },
          { type: "requestMicPermission" },
          { type: "requestWakeLock" },
        ]);
      }

      if (fsm.is("starting")) {
        if (event.type === "configReady") readiness.config = true;
        if (event.type === "micPermissionGranted") readiness.mic = true;
        if (event.type === "asrReady") readiness.asr = true;
        if (event.type === "ttsReady") readiness.tts = true;
        if (event.type === "micPermissionDenied") {
          transitionTo("error");
          return result([{ type: "setError", error: event.error }]);
        }
        return maybeEnterListening();
      }

      if (event.type === "asrFinal" && fsm.isIn(["listening", "drafting"])) {
        transitionTo("drafting");
        return result([{ type: "appendFinalToTurnBuffer", text: event.text }]);
      }

      if (event.type === "turnIdleElapsed" && fsm.is("drafting")) {
        transitionTo("submitting");
        return result([{ type: "stopCapture" }, { type: "playCue", cue: "user-end" }]);
      }

      if (event.type === "userEndCueDone" && fsm.is("submitting")) {
        transitionTo("waitingForAgent");
        return result([{ type: "submitText", text: event.text }]);
      }

      if (event.type === "agentSubmitFailed") {
        transitionTo("error");
        return result([{ type: "setError", error: event.error }]);
      }

      if (event.type === "assistantTextReady" && fsm.is("waitingForAgent")) {
        transitionTo("speaking");
        return result([
          { type: "stopCapture" },
          { type: "speakText", text: event.text, messageId: event.messageId },
        ]);
      }

      if (event.type === "ttsFinished" && fsm.is("speaking")) {
        return result([{ type: "playCue", cue: "assistant-end" }]);
      }

      if (event.type === "assistantEndCueDone" && fsm.is("speaking")) {
        transitionTo("listening");
        return result([{ type: "startCapture" }]);
      }

      return result();
    },
  };
}
