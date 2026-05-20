import { useCallback, useEffect, useRef } from "react";
import type { VoiceSummaryReason } from "@dev-anywhere/shared";
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
import { isVoicePilotAgentBusy } from "@/voice/voice-pilot-agent-state";
import {
  createVoicePilotSessionMachine,
  type VoicePilotEffect,
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
const LISTENING_START_EARCON_MS = 60;
const VOICE_TURN_IDLE_MS = 3000;
const SYSTEM_AUDIO_CAPTURE_GUARD_MS = 180;

declare global {
  interface Window {
    __devAnywhereVoicePilotTurnIdleMs?: number;
  }
}

type VoicePilotEarcon = "listening-start" | "user-end" | "assistant-end";

const VOICE_ACTIVITY_LEVEL_THRESHOLD = 0.035;

type SpeechQueueItem =
  | {
      kind: "assistant";
      key: string;
      text: string;
      messageId: string;
    }
  | {
      kind: "approval";
      key: string;
      text: string;
      messageId: string;
      requestId: string;
    };

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

function waitForSocketOpen(socket: WebSocket, timeoutMs = 3000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (socket.readyState !== WebSocket.CONNECTING) {
    return Promise.reject(new Error("语音识别连接不可用"));
  }
  return new Promise((resolve, reject) => {
    let timeoutId: number | null = null;
    const cleanup = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleUnavailable);
      socket.removeEventListener("close", handleUnavailable);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleUnavailable = () => {
      cleanup();
      reject(new Error("语音识别连接不可用"));
    };
    timeoutId = window.setTimeout(handleUnavailable, timeoutMs);
    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleUnavailable, { once: true });
    socket.addEventListener("close", handleUnavailable, { once: true });
  });
}

function firstPendingApproval(approvals: ToolApprovalRequest[]): ToolApprovalRequest | null {
  return approvals.find((approval) => approval.status === "pending") ?? null;
}

function pendingApprovalQueue(approvals: ToolApprovalRequest[]): ToolApprovalRequest[] {
  return approvals.filter((approval) => approval.status === "pending");
}

function approvalQueueContext(
  approvals: ToolApprovalRequest[],
  requestId: string,
): { position: number; total: number } {
  const queue = pendingApprovalQueue(approvals);
  const index = queue.findIndex((approval) => approval.requestId === requestId);
  return {
    position: index >= 0 ? index + 1 : 1,
    total: Math.max(1, queue.length),
  };
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
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

function approvalSummarySource(approval: ToolApprovalRequest): string {
  return [
    `toolName: ${approval.toolName}`,
    `input: ${JSON.stringify(approval.input, null, 2)}`,
  ].join("\n");
}

function approvalPromptText(summary: string, queue?: { position: number; total: number }): string {
  const trimmed = summary.trim().replace(/[。.!?！？\s]+$/u, "");
  const body = `需要审批：${trimmed || "有一个工具操作正在等待审批"}`;
  if (queue && queue.total > 1) {
    return `有 ${queue.total} 个工具审批待处理。第 ${queue.position} 个，共 ${queue.total} 个。${body}。请说允许、始终允许或拒绝。`;
  }
  return `${body}。请说允许、始终允许或拒绝。`;
}

function speechTextFingerprint(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `${text.length}:${Math.abs(hash)}`;
}

function defaultVoiceTurnIdleMs(): number {
  if (typeof window === "undefined") return VOICE_TURN_IDLE_MS;
  const override = window.__devAnywhereVoicePilotTurnIdleMs;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }
  return VOICE_TURN_IDLE_MS;
}

function voiceTurnIdleMsFromSeconds(seconds: unknown, fallbackMs: number): number {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) {
    return fallbackMs;
  }
  const ms = seconds * 1000;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : fallbackMs;
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
  const agentBusy = useSessionStore((s) => {
    const session = s.sessions.find((item) => item.sessionId === sessionId);
    const agentStatus = s.agentStatusBySessionId[sessionId];
    const ptyState = s.ptyStateBySessionId[sessionId];
    return isVoicePilotAgentBusy({
      sessionState: session?.state,
      agentPhase: agentStatus?.phase,
      ptyState: ptyState?.state,
    });
  });
  const wakeLock = useScreenWakeLockScope(`voice-pilot:${sessionId}`);
  const asrRef = useRef<WebSocket | null>(null);
  const ttsRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<PcmCapture | null>(null);
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const pilotRef = useRef<VoicePilotState>(pilot);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const approvalsRef = useRef<ToolApprovalRequest[]>(pendingApprovals);
  const agentBusyRef = useRef(agentBusy);
  const pendingSpeechRef = useRef<string[]>([]);
  const speechQueueRef = useRef<SpeechQueueItem[]>([]);
  const activeSpeechRef = useRef<SpeechQueueItem | null>(null);
  const turnBufferRef = useRef<VoiceTurnBuffer | null>(null);
  const configuredTurnIdleMsRef = useRef(turnIdleMs);
  const spokenAssistantTextByIdRef = useRef<Map<string, string>>(new Map());
  const assistantHistoryPrimedRef = useRef(false);
  const spokenApprovalRequestIdRef = useRef<string | null>(null);
  const scheduledApprovalRequestIdsRef = useRef<Set<string>>(new Set());
  const captureGenerationRef = useRef(0);
  const voiceActivitySeenRef = useRef(false);
  const captureMutedUntilRef = useRef(0);
  const ttsPlaybackEndAtRef = useRef(0);
  // 当前轮的语音 partial 气泡 id; 提交/取消/cleanup 时清空
  const voicePartialIdRef = useRef<string | null>(null);
  const sessionMachineRef = useRef<VoicePilotSessionMachine | null>(null);
  agentBusyRef.current = agentBusy;

  function ensureSessionMachine(): VoicePilotSessionMachine {
    if (!sessionMachineRef.current) {
      sessionMachineRef.current = createVoicePilotSessionMachine();
    }
    return sessionMachineRef.current;
  }

  async function dispatchEffects(effects: VoicePilotEffect[]): Promise<void> {
    for (const effect of effects) {
      switch (effect.type) {
        case "loadConfig":
          void loadConfigAndConnectRuntime();
          break;
        case "requestMicPermission":
          void sendMachineEvent({ type: "micPermissionGranted" });
          break;
        case "requestWakeLock":
          void wakeLock.enable().catch((err: unknown) => {
            reportProviderError(errorMessage(err, "无法保持屏幕常亮"));
          });
          break;
        case "releaseWakeLock":
          void wakeLock.disable().catch(() => undefined);
          break;
        case "stopCapture":
          stopCapture();
          break;
        case "startCapture":
          if (shouldCaptureNow()) {
            await beginListening();
          } else {
            stopCapture();
            syncCapturePhaseWithAgentState();
          }
          break;
        case "playCue":
          await playEarcon(effect.cue);
          break;
        case "appendFinalToTurnBuffer":
          turnBufferRef.current?.appendFinal(effect.text);
          upsertVoicePartialBubble();
          break;
        case "cancelTurnBuffer":
          turnBufferRef.current?.cancel();
          break;
        case "speakText":
        case "speakStatic": {
          const socket = ttsRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            pendingSpeechRef.current.push(effect.text);
            break;
          }
          sendSpeechNow(socket, effect.text);
          break;
        }
        case "submitText": {
          const relay = relayClientRef;
          if (!relay) {
            useVoicePilotStore.getState().setError(sessionId, "开发机连接不可用");
            break;
          }
          relay.sendEnvelope({
            type: "user_input",
            sessionId,
            payload: { text: effect.text, messageId: effect.messageId },
            seq: 0,
            timestamp: Date.now(),
            source: "client",
            version: "1",
          });
          break;
        }
        case "approveTool":
          relayClientRef?.sendControl({
            type: "tool_approve",
            sessionId,
            payload: { toolId: effect.requestId, whitelistTool: effect.whitelistTool },
          });
          break;
        case "denyTool":
          relayClientRef?.sendControl({
            type: "tool_deny",
            sessionId,
            payload: { toolId: effect.requestId },
          });
          break;
        case "requestSummary":
          void runSummaryRequest(effect.text, effect.messageId, effect.reason);
          break;
        case "cleanup":
          cleanupRuntime();
          break;
        case "setError":
          useVoicePilotStore.getState().setError(sessionId, effect.error);
          break;
        default: {
          const _exhaustiveEffect: never = effect;
          throw new Error(`Unhandled Voice Pilot effect: ${JSON.stringify(_exhaustiveEffect)}`);
        }
      }
    }
  }

  async function runSummaryRequest(
    text: string,
    messageId: string,
    reason: VoiceSummaryReason,
  ): Promise<void> {
    const relay = relayClientRef;
    const fallbackText = fallbackSpeechSummary(reason);
    if (!relay) {
      await sendMachineEvent({ type: "summaryFailed", fallbackText, messageId });
      return;
    }
    try {
      const result = await relay.requestVoiceSummary(sessionId, messageId, text, reason);
      if (result.success && result.summary?.trim()) {
        const summaryText = `下面是摘要：${result.summary.trim()}`;
        await sendMachineEvent({ type: "summaryReady", text: summaryText, messageId });
        return;
      }
    } catch {
      // Fall through to fallback summary.
    }
    await sendMachineEvent({ type: "summaryFailed", fallbackText, messageId });
  }

  async function requestApprovalSummary(approval: ToolApprovalRequest): Promise<string> {
    const fallback = describeToolApprovalForSpeech(approval);
    const relay = relayClientRef;
    if (!relay) return fallback;
    try {
      const result = await relay.requestVoiceSummary(
        sessionId,
        approval.requestId,
        approvalSummarySource(approval),
        "approval",
      );
      if (result.success && result.summary?.trim()) return result.summary.trim();
    } catch {
      // Fall through to the deterministic local approval description.
    }
    return fallback;
  }

  function queueLatestVisibleAssistantBeforeApproval(): void {
    const lastAssistant = [...messagesRef.current]
      .reverse()
      .find((message) => message.role === "assistant" && message.text.trim());
    if (!lastAssistant) return;
    speakAssistantMessage(lastAssistant);
  }

  function scheduleApprovalSpeech(approval: ToolApprovalRequest): void {
    if (!voicePilotEnabled()) return;
    if (scheduledApprovalRequestIdsRef.current.has(approval.requestId)) return;
    scheduledApprovalRequestIdsRef.current.add(approval.requestId);
    queueLatestVisibleAssistantBeforeApproval();
    void (async () => {
      try {
        const summary = await requestApprovalSummary(approval);
        if (!voicePilotEnabled()) return;
        const currentApproval = firstPendingApproval(approvalsRef.current);
        if (currentApproval?.requestId !== approval.requestId) return;
        enqueueApprovalText(
          approval,
          approvalPromptText(
            summary,
            approvalQueueContext(approvalsRef.current, approval.requestId),
          ),
        );
      } catch (err) {
        scheduledApprovalRequestIdsRef.current.delete(approval.requestId);
        useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "审批播报失败"));
      }
    })();
  }

  function sendMachineEvent(event: VoicePilotEvent): Promise<void> {
    const machine = ensureSessionMachine();
    const transition = machine.send(event);
    useVoicePilotStore.getState().setPhase(sessionId, machine.getPhase());
    return dispatchEffects(transition.effects);
  }

  function voicePilotEnabled(): boolean {
    return Boolean(useVoicePilotStore.getState().bySessionId[sessionId]?.enabled);
  }

  function currentPilotPhase(): VoicePilotState["phase"] {
    return (
      sessionMachineRef.current?.getPhase() ??
      useVoicePilotStore.getState().bySessionId[sessionId]?.phase ??
      pilotRef.current.phase
    );
  }

  function shouldCaptureNow(): boolean {
    const phase = currentPilotPhase();
    if (phase === "approval") {
      return Boolean(firstPendingApproval(approvalsRef.current));
    }
    if (phase === "listening") {
      return !agentBusyRef.current && !firstPendingApproval(approvalsRef.current);
    }
    return false;
  }

  function hasQueuedOrActiveSpeech(): boolean {
    return Boolean(activeSpeechRef.current) || speechQueueRef.current.length > 0;
  }

  function syncCapturePhaseWithAgentState(): void {
    if (!voicePilotEnabled() || !sessionMachineRef.current) return;
    const phase = currentPilotPhase();
    const hasApproval = Boolean(firstPendingApproval(approvalsRef.current));
    if (phase === "listening" && agentBusyRef.current && !hasApproval) {
      void sendMachineEvent({ type: "agentBecameBusy" });
      return;
    }
    if (
      phase === "waiting" &&
      !agentBusyRef.current &&
      !hasApproval &&
      !hasQueuedOrActiveSpeech()
    ) {
      void sendMachineEvent({ type: "agentBecameIdle" });
    }
  }

  const acceptsAsrInput = useCallback((): boolean => {
    const phase = currentPilotPhase();
    if (phase === "approval") return Boolean(firstPendingApproval(approvalsRef.current));
    if (phase === "listening") {
      return !agentBusyRef.current && !firstPendingApproval(approvalsRef.current);
    }
    return false;
  }, [sessionId]);

  function reportProviderError(error: string): void {
    if (!voicePilotEnabled() || !sessionMachineRef.current) return;
    void sendMachineEvent({ type: "providerError", error }).catch((err: unknown) => {
      if (!voicePilotEnabled()) return;
      useVoicePilotStore.getState().setError(sessionId, errorMessage(err, error));
    });
  }

  async function loadConfigAndConnectRuntime(): Promise<void> {
    if (!voicePilotEnabled()) return;
    const relay = relayClientRef;
    if (!relay) {
      await sendMachineEvent({ type: "providerError", error: "开发机连接不可用" });
      return;
    }
    try {
      const result = await relay.requestVoiceConfig();
      if (!voicePilotEnabled()) return;
      if (!result.config?.configured) {
        await sendMachineEvent({ type: "providerError", error: "请先在设置里配置 Voice Pilot。" });
        return;
      }
      configuredTurnIdleMsRef.current = voiceTurnIdleMsFromSeconds(
        result.config.turnIdleSeconds,
        turnIdleMs,
      );
      await sendMachineEvent({ type: "configReady" });
      if (!voicePilotEnabled()) return;
      ensureVoiceRuntime();
    } catch (err) {
      if (!voicePilotEnabled()) return;
      await sendMachineEvent({
        type: "providerError",
        error: errorMessage(err, "读取语音设置失败"),
      });
    }
  }

  useEffect(() => {
    pilotRef.current = pilot;
  }, [pilot]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    approvalsRef.current = pendingApprovals;
  }, [pendingApprovals]);

  const stopCapture = useCallback(() => {
    captureGenerationRef.current += 1;
    captureRef.current?.stop();
    captureRef.current = null;
    voiceActivitySeenRef.current = false;
    useVoicePilotStore.getState().setActivityLevel(sessionId, 0);
  }, [sessionId]);

  const resetVoiceActivityGate = useCallback(() => {
    voiceActivitySeenRef.current = false;
  }, []);

  const muteCaptureFor = useCallback((durationMs: number) => {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    captureMutedUntilRef.current = Math.max(
      captureMutedUntilRef.current,
      performance.now() + durationMs,
    );
  }, []);

  const captureMuted = useCallback(() => {
    return performance.now() < captureMutedUntilRef.current;
  }, []);

  const noteVoiceActivity = useCallback((level: number) => {
    if (level >= VOICE_ACTIVITY_LEVEL_THRESHOLD) {
      voiceActivitySeenRef.current = true;
    }
  }, []);

  const acceptsAsrText = useCallback((): boolean => {
    return acceptsAsrInput() && voiceActivitySeenRef.current;
  }, [acceptsAsrInput]);

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
    const generation = captureGenerationRef.current + 1;
    captureGenerationRef.current = generation;
    resetVoiceActivityGate();
    const capture = await createPcmCapture(
      (chunk) => {
        const socket = asrRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        if (!acceptsAsrInput()) return;
        if (captureMuted()) {
          useVoicePilotStore.getState().setActivityLevel(sessionId, 0);
          return;
        }
        const level = pcmActivityLevel(chunk);
        noteVoiceActivity(level);
        useVoicePilotStore.getState().setActivityLevel(sessionId, level);
        socket.send(chunk);
      },
      { sampleRate: ASR_SAMPLE_RATE },
    );
    if (captureGenerationRef.current !== generation || !acceptsAsrInput()) {
      capture.stop();
      if (captureRef.current === capture) captureRef.current = null;
      return;
    }
    captureRef.current = capture;
  }, [acceptsAsrInput, captureMuted, noteVoiceActivity, resetVoiceActivityGate, sessionId]);

  const beginListening = useCallback(async () => {
    if (captureRef.current) return;
    const socket = asrRef.current;
    if (!socket) {
      throw new Error("语音识别连接不可用");
    }
    await waitForSocketOpen(socket);
    if (!voicePilotEnabled() || asrRef.current !== socket) return;
    socket.send(JSON.stringify({ type: "start", sessionId, sampleRate: ASR_SAMPLE_RATE }));
    await startCapture();
  }, [sessionId, startCapture]);

  useEffect(() => {
    if (!enabled || !asrRef.current) return;
    if (!shouldCaptureNow()) {
      stopCapture();
      syncCapturePhaseWithAgentState();
      return;
    }
    void beginListening().catch((err: unknown) => {
      if (!voicePilotEnabled()) return;
      useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "语音识别连接不可用"));
    });
  }, [agentBusy, beginListening, enabled, sessionId, stopCapture]);

  const playEarcon = useCallback(
    async (kind: VoicePilotEarcon) => {
      const durationMs =
        kind === "user-end"
          ? USER_END_EARCON_MS
          : kind === "assistant-end"
            ? ASSISTANT_END_EARCON_MS
            : LISTENING_START_EARCON_MS;
      const frequency = kind === "user-end" ? 880 : kind === "assistant-end" ? 660 : 1100;
      const gain = kind === "user-end" ? 0.12 : kind === "assistant-end" ? 0.09 : 0.1;
      const player = playerRef.current;
      const queuedMs = player
        ? player.enqueue(createTonePcm(TTS_SAMPLE_RATE, frequency, durationMs, gain))
        : durationMs;
      const waitMs = Number.isFinite(queuedMs) ? queuedMs : durationMs;
      const guardedWaitMs = Math.max(0, waitMs) + SYSTEM_AUDIO_CAPTURE_GUARD_MS;
      muteCaptureFor(guardedWaitMs);
      await sleep(guardedWaitMs);
    },
    [muteCaptureFor],
  );

  const cleanupRuntime = useCallback(() => {
    stopCapture();
    turnBufferRef.current?.dispose();
    playerRef.current?.stop();
    captureMutedUntilRef.current = 0;
    ttsPlaybackEndAtRef.current = 0;
    const asr = asrRef.current;
    const tts = ttsRef.current;
    asrRef.current = null;
    ttsRef.current = null;
    asr?.close();
    tts?.close();
    turnBufferRef.current = null;
    playerRef.current = null;
    pendingSpeechRef.current = [];
    speechQueueRef.current = [];
    activeSpeechRef.current = null;
    scheduledApprovalRequestIdsRef.current.clear();
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

  function enqueueSpeechItem(item: SpeechQueueItem): void {
    if (!voicePilotEnabled()) return;
    if (activeSpeechRef.current?.key === item.key) return;
    if (speechQueueRef.current.some((queued) => queued.key === item.key)) return;
    speechQueueRef.current.push(item);
    void drainSpeechQueue();
  }

  async function drainSpeechQueue(): Promise<void> {
    if (!voicePilotEnabled() || activeSpeechRef.current) return;
    const next = speechQueueRef.current.shift();
    if (!next) return;
    activeSpeechRef.current = next;
    try {
      if (next.kind === "approval") {
        spokenApprovalRequestIdRef.current = next.requestId;
        await sendMachineEvent({ type: "approvalArrived", requestId: next.requestId });
        if (!voicePilotEnabled()) {
          activeSpeechRef.current = null;
          return;
        }
        const currentApproval = firstPendingApproval(approvalsRef.current);
        if (currentApproval?.requestId !== next.requestId) {
          activeSpeechRef.current = null;
          void drainSpeechQueue();
          return;
        }
        useVoicePilotStore.getState().setApproval(sessionId, next.requestId);
      }
      useVoicePilotStore.getState().setLastSpokenText(sessionId, next.text);
      await sendMachineEvent({
        type: "assistantTextReady",
        text: next.text,
        messageId: next.messageId,
      });
    } catch (err) {
      activeSpeechRef.current = null;
      useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "语音播报排队失败"));
    }
  }

  function enqueueAssistantText(text: string, messageId = ""): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const key = messageId
      ? `assistant:${messageId}:${speechTextFingerprint(trimmed)}`
      : `assistant:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    enqueueSpeechItem({ kind: "assistant", key, text: trimmed, messageId });
  }

  function enqueueApprovalText(approval: ToolApprovalRequest, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    enqueueSpeechItem({
      kind: "approval",
      key: `approval:${approval.requestId}`,
      text: trimmed,
      messageId: approval.requestId,
      requestId: approval.requestId,
    });
  }

  const speak = useCallback(
    (text: string, messageId = "") => {
      enqueueAssistantText(text, messageId);
    },
    [sessionId],
  );

  const commitRecognizedInput = useCallback(
    (text: string) => {
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
      return messageId;
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
        void sendMachineEvent({ type: "pauseRequested" });
        return true;
      }
      if (command.type === "cancel" || command.type === "redo") {
        void sendMachineEvent({ type: "cancelTurnRequested" }).catch((err: unknown) => {
          store.setError(sessionId, err instanceof Error ? err.message : String(err));
        });
        return true;
      }
      if (command.type === "resume") {
        void sendMachineEvent({ type: "resumeRequested" }).catch((err: unknown) => {
          store.setError(sessionId, err instanceof Error ? err.message : String(err));
        });
        return true;
      }
      if (command.type === "status") {
        speak(`当前语音助手状态：${pilotRef.current.phase}。`);
        return true;
      }
      const approval = firstPendingApproval(approvalsRef.current);
      if (
        approval &&
        (command.type === "approve_once" ||
          command.type === "approve_always" ||
          command.type === "deny_once")
      ) {
        void sendMachineEvent({
          type: "approvalResolved",
          action:
            command.type === "approve_once"
              ? "approve"
              : command.type === "approve_always"
                ? "approve_always"
                : "deny",
          requestId: approval.requestId,
        });
        return true;
      }
      return true;
    },
    [discardVoicePartialBubble, sessionId, speak],
  );

  const handleCompletedVoiceTurn = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      resetVoiceActivityGate();
      const approval = firstPendingApproval(approvalsRef.current);
      const route = routeVoiceText(trimmed, {
        phase: useVoicePilotStore.getState().bySessionId[sessionId]?.phase ?? "listening",
        approvalPromptActive: Boolean(approval),
      });
      if (route.kind === "command") {
        // 命令路径的 cue / cap 状态由 handleCommand 触发的 machine event 管
        handleCommand(route.command);
        return;
      }
      // 文本路径: turnIdleElapsed effect 触发 stopCapture + playCue user-end
      await sendMachineEvent({ type: "turnIdleElapsed" });
      if (!useVoicePilotStore.getState().bySessionId[sessionId]?.enabled) return;
      if (approval) {
        discardVoicePartialBubble();
        scheduleApprovalSpeech(approval);
        return;
      }
      const messageId = commitRecognizedInput(route.text);
      await sendMachineEvent({ type: "userEndCueDone", text: route.text, messageId });
    },
    [
      commitRecognizedInput,
      discardVoicePartialBubble,
      handleCommand,
      resetVoiceActivityGate,
      sessionId,
    ],
  );

  const handleFinalAsrText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    void sendMachineEvent({ type: "asrFinal", text: trimmed });
  }, []);

  function ensureVoiceRuntime(): void {
    if (turnBufferRef.current || asrRef.current || ttsRef.current || playerRef.current) return;

    turnBufferRef.current = new VoiceTurnBuffer({
      idleTimeoutMs: configuredTurnIdleMsRef.current,
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
    const player = new PcmStreamPlayer(new AudioContext(), TTS_SAMPLE_RATE, {
      onActivityLevel: (level) => {
        if (playerRef.current !== player) return;
        useVoicePilotStore.getState().setActivityLevel(sessionId, level);
      },
    });
    playerRef.current = player;

    asr.addEventListener("message", (event) => {
      const msg = parseSocketMessage(event.data);
      if (!msg) return;
      if (msg.type === "partial") {
        if (!acceptsAsrText()) return;
        turnBufferRef.current?.appendPartial(msg.text);
        upsertVoicePartialBubble();
      }
      if (msg.type === "final") {
        if (!acceptsAsrText()) return;
        void handleFinalAsrText(msg.text);
      }
      if (msg.type === "error") {
        reportProviderError(msg.error ?? "语音识别失败");
      }
    });
    tts.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        const chunk = new Uint8Array(event.data);
        const queuedMs = playerRef.current?.enqueue(chunk) ?? 0;
        if (Number.isFinite(queuedMs) && queuedMs > 0) {
          ttsPlaybackEndAtRef.current = Math.max(
            ttsPlaybackEndAtRef.current,
            performance.now() + queuedMs,
          );
          muteCaptureFor(queuedMs + SYSTEM_AUDIO_CAPTURE_GUARD_MS);
        }
        return;
      }
      const msg = parseSocketMessage(event.data);
      if (!msg) return;
      if (msg.type === "finished") {
        void (async () => {
          const queuedPlaybackMs = Math.max(0, ttsPlaybackEndAtRef.current - performance.now());
          if (queuedPlaybackMs > 0) {
            await sleep(queuedPlaybackMs);
          }
          ttsPlaybackEndAtRef.current = 0;
          useVoicePilotStore.getState().setActivityLevel(sessionId, 0);
          await sendMachineEvent({ type: "ttsFinished" });
          activeSpeechRef.current = null;
          if (!useVoicePilotStore.getState().bySessionId[sessionId]?.enabled) return;
          if (speechQueueRef.current.length > 0) {
            await drainSpeechQueue();
            return;
          }
          await sendMachineEvent({ type: "assistantEndCueDone" });
          syncCapturePhaseWithAgentState();
        })().catch((err: unknown) => {
          useVoicePilotStore
            .getState()
            .setError(sessionId, errorMessage(err, "语音播报状态更新失败"));
        });
      }
      if (msg.type === "error") {
        reportProviderError(msg.error ?? "语音播报失败");
      }
      // `closed` is a provider-socket lifecycle notification. Bailian may close the
      // upstream TTS socket normally after a finished request; active failures are
      // reported through `error` above, while browser websocket failures still hit
      // the native `close` listener below.
    });
    tts.addEventListener("close", () => {
      if (ttsRef.current !== tts || !voicePilotEnabled()) return;
      reportProviderError("语音播报连接已断开");
    });
    tts.addEventListener("error", () => {
      if (ttsRef.current !== tts || !voicePilotEnabled()) return;
      reportProviderError("语音播报连接不可用");
    });
    tts.addEventListener("open", () => {
      void sendMachineEvent({ type: "ttsReady" }).catch((err: unknown) => {
        useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "语音播报连接不可用"));
      });
      flushPendingSpeech();
    });
    runWhenOpen(asr, () => {
      void sendMachineEvent({ type: "asrReady" }).catch((err: unknown) => {
        useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "语音识别连接不可用"));
      });
    });
  }

  const speakAssistantMessage = useCallback(
    (message: ChatMessage): boolean => {
      const text = message.text.trim();
      if (!text) return false;
      const lastSpoken = spokenAssistantTextByIdRef.current.get(message.id);
      if (lastSpoken === text) return false;
      spokenAssistantTextByIdRef.current.set(message.id, text);
      const policy = decideSpeechPolicy(text);
      if (policy.mode === "direct") {
        enqueueAssistantText(text, message.id);
        return true;
      }
      const fallbackText = fallbackSpeechSummary(policy.reason);
      void (async () => {
        const relay = relayClientRef;
        if (!relay) {
          enqueueAssistantText(fallbackText, message.id);
          return;
        }
        try {
          const result = await relay.requestVoiceSummary(
            sessionId,
            message.id,
            text,
            policy.reason,
          );
          if (result.success && result.summary?.trim()) {
            enqueueAssistantText(`下面是摘要：${result.summary.trim()}`, message.id);
            return;
          }
        } catch {
          // Fall through to deterministic local fallback.
        }
        enqueueAssistantText(fallbackText, message.id);
      })();
      return true;
    },
    [sessionId],
  );

  useEffect(() => {
    if (!enabled) {
      if (sessionMachineRef.current) {
        void sendMachineEvent({ type: "disableRequested" }).catch((err: unknown) => {
          useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "停止语音助手失败"));
        });
      } else {
        cleanupRuntime();
        void wakeLock.disable().catch(() => undefined);
      }
      return;
    }

    void sendMachineEvent({ type: "enableRequested" }).catch((err: unknown) => {
      useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "启动语音助手失败"));
    });

    return () => {
      cleanupRuntime();
      void wakeLock.disable().catch(() => undefined);
    };
    // wakeLock methods are stable in the real hook; tests provide fixed spies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupRuntime, enabled, sessionId]);

  useEffect(() => {
    if (!enabled) {
      assistantHistoryPrimedRef.current = false;
      spokenAssistantTextByIdRef.current.clear();
      return;
    }
    const lastAssistant = [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && !message.isPartial);
    if (!assistantHistoryPrimedRef.current) {
      if (lastAssistant?.text.trim()) {
        spokenAssistantTextByIdRef.current.set(lastAssistant.id, lastAssistant.text.trim());
      }
      assistantHistoryPrimedRef.current = true;
      return;
    }
    if (!lastAssistant || lastAssistant.isPartial) return;
    speakAssistantMessage(lastAssistant);
  }, [enabled, messages, speakAssistantMessage]);

  useEffect(() => {
    if (!enabled) return;
    const approval = firstPendingApproval(pendingApprovals);
    if (!approval) {
      spokenApprovalRequestIdRef.current = null;
      scheduledApprovalRequestIdsRef.current.clear();
      if (pilot.approvalRequestId) {
        useVoicePilotStore.getState().setApproval(sessionId, null);
        void sendMachineEvent({
          type: "approvalCleared",
          requestId: pilot.approvalRequestId,
        }).then(() => syncCapturePhaseWithAgentState());
      }
      return;
    }
    if (
      spokenApprovalRequestIdRef.current !== approval.requestId &&
      !scheduledApprovalRequestIdsRef.current.has(approval.requestId)
    ) {
      useVoicePilotStore.getState().setApproval(sessionId, approval.requestId);
      void sendMachineEvent({ type: "approvalArrived", requestId: approval.requestId });
      scheduleApprovalSpeech(approval);
    } else {
      useVoicePilotStore.getState().setApproval(sessionId, approval.requestId);
    }
  }, [
    enabled,
    messages,
    pendingApprovals,
    pilot.approvalRequestId,
    pilot.phase,
    sessionId,
    speakAssistantMessage,
  ]);

  return null;
}
