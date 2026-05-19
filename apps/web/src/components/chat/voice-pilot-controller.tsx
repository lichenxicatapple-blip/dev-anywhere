import { useCallback, useEffect, useRef } from "react";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { getRelayClientToken } from "@/lib/relay-client-token";
import { useScreenWakeLockScope } from "@/hooks/use-screen-wake-lock";
import {
  EMPTY_SLICE,
  useChatStore,
  type ChatMessage,
  type ToolApprovalRequest,
} from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { fallbackSpeechSummary } from "@/voice/fallback-summary";
import { createPcmCapture, type PcmCapture } from "@/voice/pcm-capture";
import { PcmStreamPlayer } from "@/voice/pcm-stream-player";
import { decideSpeechPolicy } from "@/voice/speech-policy";
import { describeToolApprovalForSpeech } from "@/voice/tool-approval-speech";
import { routeVoiceText, type VoiceCommand } from "@/voice/voice-command-router";
import {
  createVoicePilotSessionMachine,
  type VoicePilotEvent,
  type VoicePilotSessionMachine,
} from "@/voice/voice-pilot-session-machine";
import { VoiceTurnBuffer } from "@/voice/voice-turn-buffer";
import {
  DEFAULT_VOICE_PILOT_STATE,
  useVoicePilotStore,
  type VoicePilotState,
} from "@/voice/voice-pilot-store";

const ASR_SAMPLE_RATE = 16000;
const TTS_SAMPLE_RATE = 24000;
const USER_END_EARCON_MS = 90;
const ASSISTANT_END_EARCON_MS = 110;
const VOICE_TURN_IDLE_MS = 3000;

declare global {
  interface Window {
    __devAnywhereVoicePilotTurnIdleMs?: number;
  }
}

type VoicePilotEarcon = "user-end" | "assistant-end";

type VoiceSocketMessage =
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "started"; requestId?: string | null }
  | { type: "finished"; requestId?: string | null }
  | { type: "closed"; code?: number; reason?: string }
  | { type: "error"; error?: string; errorCode?: string; requestId?: string | null };

function toVoiceWsUrl(path: "/voice/asr" | "/voice/tts"): string {
  const base = new URL(path, window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const token = getRelayClientToken();
  if (token) base.searchParams.set("token", token);
  return base.toString();
}

function parseSocketMessage(data: unknown): VoiceSocketMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as { type?: unknown };
    if (typeof parsed.type !== "string") return null;
    return parsed as VoiceSocketMessage;
  } catch {
    return null;
  }
}

function runWhenOpen(socket: WebSocket, callback: () => void): void {
  if (socket.readyState === WebSocket.OPEN) {
    callback();
    return;
  }
  socket.addEventListener("open", callback, { once: true });
}

function firstPendingApproval(approvals: ToolApprovalRequest[]): ToolApprovalRequest | null {
  return approvals.find((approval) => approval.status === "pending") ?? null;
}

function pcmActivityLevel(chunk: Uint8Array): number {
  if (chunk.byteLength < 2) return 0;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const sampleCount = Math.floor(chunk.byteLength / 2);
  const stride = Math.max(1, Math.floor(sampleCount / 512));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < sampleCount; i += stride) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sum += sample * sample;
    count += 1;
  }
  if (count === 0) return 0;
  return Math.min(1, Math.sqrt(sum / count) * 10);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function createTonePcm(
  sampleRate: number,
  frequency: number,
  durationMs: number,
  gain: number,
): Uint8Array {
  const sampleCount = Math.max(1, Math.ceil((sampleRate * durationMs) / 1000));
  const fadeSamples = Math.max(1, Math.floor(sampleRate * 0.006));
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const attack = Math.min(1, i / fadeSamples);
    const release = Math.min(1, (sampleCount - i - 1) / fadeSamples);
    const envelope = Math.max(0, Math.min(attack, release));
    const wave = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    samples[i] = Math.round(wave * envelope * gain * 32767);
  }
  return new Uint8Array(samples.buffer);
}

function renderTurnBufferText(
  snapshot: { draft: string; partial: string } | null | undefined,
): string {
  if (!snapshot) return "";
  const { draft, partial } = snapshot;
  if (draft && partial) return `${draft}\n${partial}`;
  return draft || partial;
}

function defaultVoiceTurnIdleMs(): number {
  if (typeof window === "undefined") return VOICE_TURN_IDLE_MS;
  const override = window.__devAnywhereVoicePilotTurnIdleMs;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }
  return VOICE_TURN_IDLE_MS;
}

export function VoicePilotController({
  sessionId,
  turnIdleMs = defaultVoiceTurnIdleMs(),
}: {
  sessionId: string;
  turnIdleMs?: number;
}) {
  const pilot = useVoicePilotStore((s) => s.bySessionId[sessionId] ?? DEFAULT_VOICE_PILOT_STATE);
  const enabled = pilot.enabled;
  const messages = useChatStore((s) => s.bySessionId[sessionId]?.messages ?? EMPTY_SLICE.messages);
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[sessionId]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );
  const wakeLock = useScreenWakeLockScope(`voice-pilot:${sessionId}`);
  const asrRef = useRef<WebSocket | null>(null);
  const ttsRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<PcmCapture | null>(null);
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const pilotRef = useRef<VoicePilotState>(pilot);
  const approvalsRef = useRef<ToolApprovalRequest[]>(pendingApprovals);
  const pendingSpeechRef = useRef<string[]>([]);
  const turnBufferRef = useRef<VoiceTurnBuffer | null>(null);
  const processedAssistantMessageIdRef = useRef<string | null>(null);
  const spokenApprovalRequestIdRef = useRef<string | null>(null);
  // 当前轮的语音 partial 气泡 id; 提交/取消/cleanup 时清空
  const voicePartialIdRef = useRef<string | null>(null);
  const sessionMachineRef = useRef<VoicePilotSessionMachine | null>(null);

  function ensureSessionMachine(): VoicePilotSessionMachine {
    if (!sessionMachineRef.current) {
      sessionMachineRef.current = createVoicePilotSessionMachine();
    }
    return sessionMachineRef.current;
  }

  function sendMachineEvent(event: VoicePilotEvent): void {
    const machine = ensureSessionMachine();
    machine.send(event);
    useVoicePilotStore.getState().setPhase(sessionId, machine.getPhase());
  }

  useEffect(() => {
    pilotRef.current = pilot;
  }, [pilot]);

  useEffect(() => {
    approvalsRef.current = pendingApprovals;
  }, [pendingApprovals]);

  const stopCapture = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    useVoicePilotStore.getState().setActivityLevel(sessionId, 0);
  }, [sessionId]);

  const discardVoicePartialBubble = useCallback(() => {
    const id = voicePartialIdRef.current;
    voicePartialIdRef.current = null;
    if (!id) return;
    useChatStore.getState().removeMessage(sessionId, id);
  }, [sessionId]);

  const upsertVoicePartialBubble = useCallback(() => {
    const text = renderTurnBufferText(turnBufferRef.current?.getSnapshot());
    if (!text) {
      discardVoicePartialBubble();
      return;
    }
    if (!voicePartialIdRef.current) {
      voicePartialIdRef.current = `${sessionId}-voice-user-${Date.now()}`;
    }
    useChatStore.getState().upsertUserMessage(sessionId, {
      id: voicePartialIdRef.current,
      role: "user",
      text,
      isPartial: true,
      timestamp: Date.now(),
      toolCalls: [],
    });
  }, [discardVoicePartialBubble, sessionId]);

  const startCapture = useCallback(async () => {
    if (captureRef.current) return;
    captureRef.current = await createPcmCapture(
      (chunk) => {
        const socket = asrRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        if (pilotRef.current.phase === "speaking") return;
        useVoicePilotStore.getState().setActivityLevel(sessionId, pcmActivityLevel(chunk));
        socket.send(chunk);
      },
      { sampleRate: ASR_SAMPLE_RATE },
    );
  }, [sessionId]);

  const beginListening = useCallback(async () => {
    if (captureRef.current) return;
    const socket = asrRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("语音识别连接不可用");
    }
    socket.send(JSON.stringify({ type: "start", sessionId, sampleRate: ASR_SAMPLE_RATE }));
    await startCapture();
  }, [sessionId, startCapture]);

  const playEarcon = useCallback(async (kind: VoicePilotEarcon) => {
    const player = playerRef.current;
    if (!player) return;
    const durationMs = kind === "user-end" ? USER_END_EARCON_MS : ASSISTANT_END_EARCON_MS;
    const frequency = kind === "user-end" ? 880 : 660;
    const gain = kind === "user-end" ? 0.12 : 0.09;
    const queuedMs = player.enqueue(createTonePcm(TTS_SAMPLE_RATE, frequency, durationMs, gain));
    const waitMs = Number.isFinite(queuedMs) ? queuedMs : durationMs;
    await sleep(Math.max(0, waitMs));
  }, []);

  const cleanupRuntime = useCallback(() => {
    stopCapture();
    turnBufferRef.current?.dispose();
    playerRef.current?.stop();
    asrRef.current?.close();
    ttsRef.current?.close();
    asrRef.current = null;
    ttsRef.current = null;
    turnBufferRef.current = null;
    playerRef.current = null;
    pendingSpeechRef.current = [];
    discardVoicePartialBubble();
    sessionMachineRef.current = null;
  }, [discardVoicePartialBubble, stopCapture]);

  const sendSpeechNow = useCallback(
    (socket: WebSocket, text: string) => {
      socket.send(
        JSON.stringify({
          type: "speak",
          requestId: `${sessionId}-tts-${Date.now()}`,
          text,
        }),
      );
    },
    [sessionId],
  );

  const flushPendingSpeech = useCallback(() => {
    const socket = ttsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const pending = pendingSpeechRef.current.splice(0);
    for (const text of pending) {
      sendSpeechNow(socket, text);
    }
  }, [sendSpeechNow]);

  const speak = useCallback(
    (text: string, messageId = "") => {
      const trimmed = text.trim();
      if (!trimmed) return;
      stopCapture();
      useVoicePilotStore.getState().setLastSpokenText(sessionId, trimmed);
      sendMachineEvent({ type: "assistantTextReady", text: trimmed, messageId });
      const socket = ttsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        pendingSpeechRef.current.push(trimmed);
        return;
      }
      sendSpeechNow(socket, trimmed);
    },
    [sendSpeechNow, sessionId, stopCapture],
  );

  const sendRecognizedInput = useCallback(
    (text: string) => {
      const relay = relayClientRef;
      if (!relay) {
        useVoicePilotStore.getState().setError(sessionId, "开发机连接不可用");
        return;
      }
      const now = Date.now();
      const messageId = voicePartialIdRef.current ?? `${sessionId}-voice-user-${now}`;
      voicePartialIdRef.current = null;
      useChatStore.getState().upsertUserMessage(sessionId, {
        id: messageId,
        role: "user",
        text,
        isPartial: false,
        timestamp: now,
        toolCalls: [],
      });
      useSessionStore.getState().updateSessionState(sessionId, "working", now);
      relay.sendEnvelope({
        type: "user_input",
        sessionId,
        payload: { text, messageId },
        seq: 0,
        timestamp: now,
        source: "client",
        version: "1",
      });
      sendMachineEvent({ type: "userTextRecognized", text });
    },
    [sessionId],
  );

  const handleCommand = useCallback(
    (command: VoiceCommand): boolean => {
      const store = useVoicePilotStore.getState();
      // 命令文本不进消息历史: 任何命令路径先丢弃当前轮的 partial 气泡
      discardVoicePartialBubble();
      if (command.type === "repeat") {
        speak(pilotRef.current.lastSpokenText || "还没有可以复述的内容。");
        return true;
      }
      if (command.type === "exit") {
        store.disable(sessionId);
        return true;
      }
      if (command.type === "pause") {
        stopCapture();
        sendMachineEvent({ type: "pauseRequested" });
        return true;
      }
      if (command.type === "cancel" || command.type === "redo") {
        turnBufferRef.current?.cancel();
        sendMachineEvent({ type: "cancelTurnRequested" });
        void beginListening().catch((err: unknown) => {
          store.setError(sessionId, err instanceof Error ? err.message : String(err));
        });
        return true;
      }
      if (command.type === "resume") {
        sendMachineEvent({ type: "resumeRequested" });
        void beginListening().catch((err: unknown) => {
          store.setError(sessionId, err instanceof Error ? err.message : String(err));
        });
        return true;
      }
      if (command.type === "status") {
        speak(`当前语音助手状态：${pilotRef.current.phase}。`);
        return true;
      }
      const approval = firstPendingApproval(approvalsRef.current);
      if (approval && (command.type === "approve_once" || command.type === "deny_once")) {
        relayClientRef?.sendControl(
          command.type === "approve_once"
            ? {
                type: "tool_approve",
                sessionId,
                payload: { toolId: approval.requestId, whitelistTool: false },
              }
            : {
                type: "tool_deny",
                sessionId,
                payload: { toolId: approval.requestId },
              },
        );
        sendMachineEvent({
          type: "approvalResolved",
          action: command.type === "approve_once" ? "approve" : "deny",
          requestId: approval.requestId,
        });
        return true;
      }
      return true;
    },
    [beginListening, discardVoicePartialBubble, sessionId, speak, stopCapture],
  );

  const handleCompletedVoiceTurn = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const approval = firstPendingApproval(approvalsRef.current);
      const route = routeVoiceText(trimmed, {
        phase: useVoicePilotStore.getState().bySessionId[sessionId]?.phase ?? "listening",
        approvalPromptActive: Boolean(approval),
      });
      stopCapture();
      await playEarcon("user-end");
      if (!useVoicePilotStore.getState().bySessionId[sessionId]?.enabled) return;
      if (route.kind === "command") {
        handleCommand(route.command);
        return;
      }
      sendMachineEvent({ type: "turnIdleElapsed" });
      if (approval) {
        discardVoicePartialBubble();
        sendMachineEvent({ type: "approvalArrived", requestId: approval.requestId });
        useVoicePilotStore.getState().setApproval(sessionId, approval.requestId);
        speak("请说批准这次或拒绝这次。", approval.requestId);
        return;
      }
      sendRecognizedInput(route.text);
    },
    [
      discardVoicePartialBubble,
      handleCommand,
      playEarcon,
      sendRecognizedInput,
      sessionId,
      speak,
      stopCapture,
    ],
  );

  const handleFinalAsrText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      turnBufferRef.current?.appendFinal(trimmed);
      upsertVoicePartialBubble();
    },
    [upsertVoicePartialBubble],
  );

  const speakAssistantMessage = useCallback(
    async (message: ChatMessage) => {
      const policy = decideSpeechPolicy(message.text);
      if (policy.mode === "direct") {
        speak(message.text, message.id);
        return;
      }

      const relay = relayClientRef;
      sendMachineEvent({
        type: "summaryRequested",
        text: message.text,
        messageId: message.id,
        reason: policy.reason,
      });
      if (!relay) {
        const fallbackText = fallbackSpeechSummary(policy.reason);
        sendMachineEvent({ type: "summaryFailed", fallbackText, messageId: message.id });
        speak(fallbackText, message.id);
        return;
      }
      try {
        const result = await relay.requestVoiceSummary(
          sessionId,
          message.id,
          message.text,
          policy.reason,
        );
        if (result.success && result.summary?.trim()) {
          const summaryText = `下面是摘要：${result.summary.trim()}`;
          sendMachineEvent({ type: "summaryReady", text: summaryText, messageId: message.id });
          speak(summaryText, message.id);
          return;
        }
      } catch {
        // Fall through to deterministic fallback.
      }
      const fallbackText = fallbackSpeechSummary(policy.reason);
      sendMachineEvent({ type: "summaryFailed", fallbackText, messageId: message.id });
      speak(fallbackText, message.id);
    },
    [sessionId, speak],
  );

  useEffect(() => {
    if (!enabled) {
      cleanupRuntime();
      void wakeLock.disable().catch(() => undefined);
      return;
    }

    let cancelled = false;
    sendMachineEvent({ type: "enableRequested" });

    async function start() {
      const relay = relayClientRef;
      if (!relay) {
        useVoicePilotStore.getState().setError(sessionId, "开发机连接不可用");
        return;
      }
      try {
        const result = await relay.requestVoiceConfig();
        if (cancelled) return;
        if (!result.config?.configured) {
          useVoicePilotStore.getState().setError(sessionId, "请先在设置里配置 Voice Pilot。");
          return;
        }
        sendMachineEvent({ type: "configReady" });
        await wakeLock.enable();
        if (cancelled) return;
        sendMachineEvent({ type: "micPermissionGranted" });

        turnBufferRef.current = new VoiceTurnBuffer({
          idleTimeoutMs: turnIdleMs,
          onTurnReady: (text) => {
            void handleCompletedVoiceTurn(text);
          },
        });
        const asr = new WebSocket(toVoiceWsUrl("/voice/asr"));
        const tts = new WebSocket(toVoiceWsUrl("/voice/tts"));
        asr.binaryType = "arraybuffer";
        tts.binaryType = "arraybuffer";
        asrRef.current = asr;
        ttsRef.current = tts;
        playerRef.current = new PcmStreamPlayer(new AudioContext(), TTS_SAMPLE_RATE);

        asr.addEventListener("message", (event) => {
          const msg = parseSocketMessage(event.data);
          if (!msg) return;
          if (msg.type === "partial") {
            turnBufferRef.current?.appendPartial(msg.text);
            upsertVoicePartialBubble();
          }
          if (msg.type === "final") void handleFinalAsrText(msg.text);
          if (msg.type === "error") {
            useVoicePilotStore.getState().setError(sessionId, msg.error ?? "语音识别失败");
          }
        });
        tts.addEventListener("message", (event) => {
          if (event.data instanceof ArrayBuffer) {
            const chunk = new Uint8Array(event.data);
            useVoicePilotStore.getState().setActivityLevel(sessionId, pcmActivityLevel(chunk));
            playerRef.current?.enqueue(chunk);
            return;
          }
          const msg = parseSocketMessage(event.data);
          if (!msg) return;
          if (msg.type === "finished") {
            void (async () => {
              useVoicePilotStore.getState().setActivityLevel(sessionId, 0);
              sendMachineEvent({ type: "ttsFinished" });
              await playEarcon("assistant-end");
              if (!useVoicePilotStore.getState().bySessionId[sessionId]?.enabled) return;
              const approval = firstPendingApproval(approvalsRef.current);
              if (approval) {
                sendMachineEvent({ type: "approvalArrived", requestId: approval.requestId });
                useVoicePilotStore.getState().setApproval(sessionId, approval.requestId);
              } else {
                sendMachineEvent({ type: "assistantEndCueDone" });
              }
              await beginListening();
            })().catch((err: unknown) => {
              useVoicePilotStore
                .getState()
                .setError(sessionId, err instanceof Error ? err.message : String(err));
            });
          }
          if (msg.type === "error") {
            useVoicePilotStore.getState().setError(sessionId, msg.error ?? "语音播报失败");
          }
        });
        tts.addEventListener("open", () => {
          sendMachineEvent({ type: "ttsReady" });
          flushPendingSpeech();
        });
        runWhenOpen(asr, () => {
          sendMachineEvent({ type: "asrReady" });
          void beginListening().catch((err: unknown) => {
            useVoicePilotStore
              .getState()
              .setError(sessionId, err instanceof Error ? err.message : String(err));
          });
        });
      } catch (err) {
        if (!cancelled) {
          useVoicePilotStore
            .getState()
            .setError(sessionId, err instanceof Error ? err.message : String(err));
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      cleanupRuntime();
      void wakeLock.disable().catch(() => undefined);
    };
    // wakeLock methods are stable in the real hook; tests provide fixed spies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    beginListening,
    cleanupRuntime,
    enabled,
    flushPendingSpeech,
    handleCompletedVoiceTurn,
    handleFinalAsrText,
    playEarcon,
    sessionId,
    turnIdleMs,
    upsertVoicePartialBubble,
  ]);

  useEffect(() => {
    if (!enabled) return;
    const approval = firstPendingApproval(pendingApprovals);
    if (!approval) {
      spokenApprovalRequestIdRef.current = null;
      if (pilot.approvalRequestId) {
        useVoicePilotStore.getState().setApproval(sessionId, null);
      }
      return;
    }
    if (spokenApprovalRequestIdRef.current !== approval.requestId) {
      spokenApprovalRequestIdRef.current = approval.requestId;
      sendMachineEvent({ type: "approvalArrived", requestId: approval.requestId });
      useVoicePilotStore.getState().setApproval(sessionId, approval.requestId);
      speak(
        `${describeToolApprovalForSpeech(approval)} 请说批准这次或拒绝这次。`,
        approval.requestId,
      );
    } else {
      useVoicePilotStore.getState().setApproval(sessionId, approval.requestId);
    }
  }, [enabled, pendingApprovals, pilot.approvalRequestId, sessionId, speak]);

  useEffect(() => {
    if (!enabled) return;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (!lastAssistant || lastAssistant.isPartial) return;
    if (processedAssistantMessageIdRef.current === lastAssistant.id) return;
    processedAssistantMessageIdRef.current = lastAssistant.id;
    void speakAssistantMessage(lastAssistant);
  }, [enabled, messages, speakAssistantMessage]);

  return null;
}
