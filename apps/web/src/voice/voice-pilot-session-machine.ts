import { createFSM, type VoiceSummaryReason } from "@dev-anywhere/shared";
import type { VoicePilotPhase } from "./voice-pilot-store";

export type VoicePilotEffect =
  | { type: "loadConfig" }
  | { type: "requestMicPermission" }
  | { type: "requestWakeLock" }
  | { type: "releaseWakeLock" }
  | { type: "startCapture" }
  | { type: "stopCapture" }
  | { type: "appendFinalToTurnBuffer"; text: string }
  | { type: "cancelTurnBuffer" }
  | { type: "playCue"; cue: "listening-start" | "user-end" | "assistant-end" }
  | { type: "submitText"; text: string; messageId: string }
  | { type: "speakText"; text: string; messageId: string }
  | { type: "speakStatic"; text: string }
  | { type: "requestSummary"; text: string; messageId: string; reason: VoiceSummaryReason }
  | { type: "approveTool"; requestId: string; whitelistTool: boolean }
  | { type: "denyTool"; requestId: string }
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
  | { type: "userEndCueDone"; text: string; messageId: string }
  | { type: "userTextRecognized"; text: string; messageId: string }
  | { type: "agentSubmitFailed"; error: string }
  | { type: "assistantTextReady"; text: string; messageId: string }
  | { type: "summaryRequested"; text: string; messageId: string; reason: VoiceSummaryReason }
  | { type: "summaryReady"; text: string; messageId: string }
  | { type: "summaryFailed"; fallbackText: string; messageId: string }
  | { type: "ttsFinished" }
  | { type: "assistantEndCueDone" }
  | { type: "agentBecameBusy" }
  | { type: "agentBecameIdle" }
  | { type: "providerError"; error: string }
  | { type: "pauseRequested" }
  | { type: "resumeRequested" }
  | { type: "cancelTurnRequested" }
  | { type: "approvalArrived"; requestId: string }
  | { type: "approvalCleared"; requestId: string }
  | { type: "approvalResolved"; action: "approve" | "approve_always" | "deny"; requestId: string };

export interface VoicePilotTransitionResult {
  phase: VoicePilotPhase;
  effects: VoicePilotEffect[];
}

interface Readiness {
  config: boolean;
  mic: boolean;
  asr: boolean;
  tts: boolean;
}

const VOICE_PILOT_TRANSITIONS: Record<VoicePilotPhase, readonly VoicePilotPhase[]> = {
  idle: ["starting"],
  starting: ["listening", "speaking", "summarizing", "error", "idle"],
  listening: [
    "submitting",
    "waiting",
    "speaking",
    "summarizing",
    "approval",
    "paused",
    "error",
    "idle",
  ],
  submitting: ["waiting", "speaking", "approval", "error", "idle"],
  waiting: ["listening", "speaking", "summarizing", "approval", "error", "idle"],
  summarizing: ["speaking", "approval", "error", "idle"],
  speaking: ["waiting", "listening", "approval", "error", "idle"],
  approval: ["waiting", "speaking", "error", "idle"],
  paused: ["listening", "error", "idle"],
  error: ["idle"],
};

// Runtime invariants:
// - `listening` is only allowed when config/runtime are ready, no approval is pending,
//   no speech is queued, and the agent is idle. The controller owns those external facts.
// - `approval` is only allowed while a pending tool approval exists; card clicks and
//   voice commands both leave it through explicit events rather than mutating store state.
// - `speaking` means the browser is still waiting for the active TTS request to finish
//   and play its local completion cue.
// - `waiting` is the neutral busy state: the agent may be thinking, a turn may have just
//   been submitted, or speech just ended before listening is permitted again.

export interface VoicePilotSessionMachine {
  send(event: VoicePilotEvent): VoicePilotTransitionResult;
  getPhase(): VoicePilotPhase;
  hydrateReadyForTest(phase: VoicePilotPhase): void;
}

export function createVoicePilotSessionMachine(): VoicePilotSessionMachine {
  let fsm = createFSM<VoicePilotPhase>({
    initial: "idle",
    transitions: VOICE_PILOT_TRANSITIONS,
  });
  let readiness: Readiness = { config: false, mic: false, asr: false, tts: false };

  function result(effects: VoicePilotEffect[] = []): VoicePilotTransitionResult {
    return { phase: fsm.current(), effects };
  }

  function transitionTo(phase: VoicePilotPhase): void {
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
      fsm = createFSM<VoicePilotPhase>({
        initial: nextPhase,
        transitions: VOICE_PILOT_TRANSITIONS,
      });
      readiness = { config: true, mic: true, asr: true, tts: true };
    },

    send(event): VoicePilotTransitionResult {
      if (event.type === "disableRequested") {
        transitionTo("idle");
        readiness = { config: false, mic: false, asr: false, tts: false };
        return result([{ type: "stopCapture" }, { type: "releaseWakeLock" }, { type: "cleanup" }]);
      }

      if (event.type === "providerError") {
        transitionTo("error");
        return result([{ type: "stopCapture" }, { type: "setError", error: event.error }]);
      }

      if (event.type === "enableRequested" && fsm.is("idle")) {
        transitionTo("starting");
        readiness = { config: false, mic: false, asr: false, tts: false };
        return result([
          { type: "loadConfig" },
          { type: "requestMicPermission" },
          { type: "requestWakeLock" },
        ]);
      }

      if (fsm.is("starting")) {
        if (event.type === "configReady") {
          readiness.config = true;
          return maybeEnterListening();
        }
        if (event.type === "micPermissionGranted") {
          readiness.mic = true;
          return maybeEnterListening();
        }
        if (event.type === "asrReady") {
          readiness.asr = true;
          return maybeEnterListening();
        }
        if (event.type === "ttsReady") {
          readiness.tts = true;
          return maybeEnterListening();
        }
        if (event.type === "micPermissionDenied") {
          transitionTo("error");
          return result([{ type: "setError", error: event.error }]);
        }
      }

      if (event.type === "asrFinal" && (fsm.is("listening") || fsm.is("approval"))) {
        return result([{ type: "appendFinalToTurnBuffer", text: event.text }]);
      }

      if (event.type === "turnIdleElapsed" && fsm.is("listening")) {
        transitionTo("submitting");
        return result([{ type: "stopCapture" }, { type: "playCue", cue: "user-end" }]);
      }

      if (event.type === "userEndCueDone" && fsm.is("submitting")) {
        transitionTo("waiting");
        return result([{ type: "submitText", text: event.text, messageId: event.messageId }]);
      }

      if (event.type === "agentSubmitFailed") {
        transitionTo("error");
        return result([{ type: "setError", error: event.error }]);
      }

      if (event.type === "assistantTextReady" && fsm.is("waiting")) {
        transitionTo("speaking");
        return result([
          { type: "stopCapture" },
          { type: "speakText", text: event.text, messageId: event.messageId },
        ]);
      }

      if (event.type === "ttsFinished" && fsm.isIn(["speaking", "approval", "paused"])) {
        return result([{ type: "playCue", cue: "assistant-end" }]);
      }

      if (event.type === "assistantEndCueDone" && fsm.is("speaking")) {
        transitionTo("waiting");
        return result([]);
      }

      if (event.type === "assistantEndCueDone" && fsm.is("approval")) {
        return result([{ type: "startCapture" }]);
      }

      if (event.type === "assistantEndCueDone" && fsm.is("paused")) {
        return result([]);
      }

      if (event.type === "agentBecameBusy" && fsm.is("listening")) {
        transitionTo("waiting");
        return result([{ type: "stopCapture" }, { type: "cancelTurnBuffer" }]);
      }

      if (event.type === "agentBecameIdle" && fsm.is("waiting")) {
        transitionTo("listening");
        return result([{ type: "startCapture" }]);
      }

      if (event.type === "pauseRequested" && fsm.is("listening")) {
        transitionTo("paused");
        return result([{ type: "stopCapture" }, { type: "playCue", cue: "user-end" }]);
      }

      if (event.type === "resumeRequested" && fsm.is("paused")) {
        transitionTo("listening");
        return result([{ type: "playCue", cue: "listening-start" }, { type: "startCapture" }]);
      }

      if (event.type === "cancelTurnRequested" && fsm.is("listening")) {
        return result([
          { type: "cancelTurnBuffer" },
          { type: "playCue", cue: "user-end" },
          { type: "startCapture" },
        ]);
      }

      if (
        event.type === "approvalArrived" &&
        fsm.isIn(["listening", "submitting", "waiting", "speaking", "summarizing"])
      ) {
        transitionTo("approval");
        return result([{ type: "stopCapture" }, { type: "cancelTurnBuffer" }]);
      }

      if (event.type === "approvalCleared" && fsm.is("approval")) {
        transitionTo("waiting");
        return result([{ type: "stopCapture" }, { type: "cancelTurnBuffer" }]);
      }

      if (event.type === "approvalResolved" && fsm.is("approval")) {
        transitionTo("waiting");
        return result([
          event.action === "approve"
            ? { type: "approveTool", requestId: event.requestId, whitelistTool: false }
            : event.action === "approve_always"
              ? { type: "approveTool", requestId: event.requestId, whitelistTool: true }
              : { type: "denyTool", requestId: event.requestId },
          { type: "playCue", cue: "user-end" },
        ]);
      }

      if (event.type === "summaryRequested" && fsm.isIn(["waiting", "listening", "starting"])) {
        transitionTo("summarizing");
        return result([
          { type: "stopCapture" },
          {
            type: "requestSummary",
            text: event.text,
            messageId: event.messageId,
            reason: event.reason,
          },
        ]);
      }

      if (event.type === "summaryReady" && fsm.is("summarizing")) {
        transitionTo("speaking");
        return result([{ type: "speakText", text: event.text, messageId: event.messageId }]);
      }

      if (event.type === "summaryFailed" && fsm.is("summarizing")) {
        transitionTo("speaking");
        return result([
          { type: "speakText", text: event.fallbackText, messageId: event.messageId },
        ]);
      }

      if (event.type === "userTextRecognized" && fsm.is("submitting")) {
        transitionTo("waiting");
        return result([{ type: "submitText", text: event.text, messageId: event.messageId }]);
      }

      if (event.type === "assistantTextReady" && fsm.is("approval")) {
        return result([
          { type: "stopCapture" },
          { type: "speakText", text: event.text, messageId: event.messageId },
        ]);
      }

      if (event.type === "assistantTextReady" && fsm.is("paused")) {
        return result([{ type: "speakText", text: event.text, messageId: event.messageId }]);
      }

      if (
        event.type === "assistantTextReady" &&
        fsm.isIn(["starting", "listening", "submitting", "summarizing"])
      ) {
        transitionTo("speaking");
        return result([
          { type: "stopCapture" },
          { type: "speakText", text: event.text, messageId: event.messageId },
        ]);
      }

      return result();
    },
  };
}
