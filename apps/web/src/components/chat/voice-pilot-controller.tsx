import { useCallback, useEffect, useRef } from "react";
import { encodePcm16ToMuLaw, type VoiceSummaryReason } from "@dev-anywhere/shared";
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
import {
  voiceAudioSession,
  type VoiceAudioSessionLease,
  type VoiceAudioSessionMode,
} from "@/voice/browser-audio-session";
import { int16PcmEnvelope } from "@/voice/pcm-waveform";
import { PcmStreamPlayer, type PcmStreamPlayerEvent } from "@/voice/pcm-stream-player";
import {
  createSpeechCapture,
  resolveVoiceSpeechSource,
  type VoiceSpeechCapture,
} from "@/voice/speech-capture";
import { SpeechInputPipeline } from "@/voice/speech-input-pipeline";
import { VoiceAsrTransport } from "@/voice/voice-asr-transport";
import { voicePlaybackContext } from "@/voice/voice-playback-context";
import { decideSpeechPolicy } from "@/voice/speech-policy";
import { describeToolApprovalForSpeech } from "@/voice/tool-approval-speech";
import { routeVoiceText, type VoiceCommand } from "@/voice/voice-command-router";
import { isVoicePilotAgentBusy } from "@/voice/voice-pilot-agent-state";
import {
  createVoicePilotEarcon,
  type VoicePilotEarcon,
} from "@/voice/voice-pilot-earcon";
import {
  createVoicePilotSessionMachine,
  type VoicePilotEffect,
  type VoicePilotEvent,
  type VoicePilotSessionMachine,
} from "@/voice/voice-pilot-session-machine";
import { VoiceTurnBuffer } from "@/voice/voice-turn-buffer";
import {
  recordVoicePilotDiagnostic,
  type VoicePilotDiagnosticInput,
  type VoicePilotDiagnosticScope,
} from "@/voice/voice-pilot-diagnostics";
import {
  DEFAULT_VOICE_PILOT_STATE,
  useVoicePilotStore,
  type VoicePilotState,
} from "@/voice/voice-pilot-store";
import { voicePilotWakeLockScopeKey } from "@/voice/voice-pilot-wake-lock";

const ASR_SAMPLE_RATE = 16000;
const TTS_SAMPLE_RATE = 24000;
const VOICE_TURN_IDLE_MS = 3000;
const SYSTEM_AUDIO_CAPTURE_GUARD_MS = 180;
const WAVEFORM_BINS_PER_PCM_CHUNK = 8;
// Keep enough audio to cover local VAD confirmation and provider startup.
const SPEECH_PRE_ROLL_MS = 1200;
const MU_LAW_BYTES_PER_SECOND = ASR_SAMPLE_RATE;
const APPROVAL_DECISION_HINT = "当前正在等待审批，请说允许、始终允许或拒绝。";

declare global {
  interface Window {
    __devAnywhereVoicePilotTurnIdleMs?: number;
  }
}

interface TtsClientStats {
  requestId: string;
  requestedAt: number;
  startedAt: number | null;
  firstPcmAt: number | null;
  pcmBytes: number;
  pcmChunks: number;
}

type VoiceTraceOptions = Omit<VoicePilotDiagnosticInput, "sessionId" | "scope" | "event">;

function toVoiceTraceDetails(
  details: Record<string, unknown>,
): NonNullable<VoiceTraceOptions["details"]> {
  const normalized: NonNullable<VoiceTraceOptions["details"]> = {};
  for (const [key, value] of Object.entries(details)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      normalized[key] = value;
    }
  }
  return normalized;
}

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
  | { type: "ready"; attemptId?: string }
  | { type: "partial"; attemptId?: string; text: string }
  | { type: "final"; attemptId?: string; text: string }
  | { type: "started"; requestId?: string | null }
  | { type: "finished"; requestId?: string | null }
  | { type: "closed"; attemptId?: string; code?: number; reason?: string }
  | {
      type: "error";
      attemptId?: string;
      error?: string;
      errorCode?: string;
      requestId?: string | null;
    };

function browserAudioSessionType(): string | null {
  return (
    (
      navigator as Navigator & {
        audioSession?: { type?: string };
      }
    ).audioSession?.type ?? null
  );
}

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

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
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

function useEventCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });
  return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
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
  const wakeLock = useScreenWakeLockScope(voicePilotWakeLockScopeKey(sessionId));
  const asrTransportRef = useRef<VoiceAsrTransport | null>(null);
  const ttsRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<VoiceSpeechCapture | null>(null);
  const speechInputRef = useRef<SpeechInputPipeline | null>(null);
  const asrAttemptIdRef = useRef<string | null>(null);
  const listeningStartRef = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const captureShutdownRef = useRef<Promise<void>>(Promise.resolve());
  const playbackRefreshRequiredRef = useRef(false);
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const audioSessionLeaseRef = useRef<VoiceAudioSessionLease | null>(null);
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
  const captureMutedUntilRef = useRef(0);
  const ttsPlaybackEndAtRef = useRef(0);
  const activeTtsRequestIdRef = useRef<string | null>(null);
  const ttsStatsRef = useRef<Map<string, TtsClientStats>>(new Map());
  // 当前轮的语音 partial 气泡 id; 提交/取消/cleanup 时清空
  const voicePartialIdRef = useRef<string | null>(null);
  const sessionMachineRef = useRef<VoicePilotSessionMachine | null>(null);
  agentBusyRef.current = agentBusy;

  const traceVoice = useCallback(
    (scope: VoicePilotDiagnosticScope, event: string, options: VoiceTraceOptions = {}): void => {
      recordVoicePilotDiagnostic({ sessionId, scope, event, ...options });
    },
    [sessionId],
  );

  const setAudioSessionMode = useCallback(
    (mode: VoiceAudioSessionMode): void => {
      const previousType = browserAudioSessionType();
      try {
        if (!audioSessionLeaseRef.current) {
          audioSessionLeaseRef.current = voiceAudioSession.acquire(mode);
        } else {
          audioSessionLeaseRef.current.setMode(mode);
        }
        traceVoice("audio-session", "mode-applied", {
          details: { mode, previousType, currentType: browserAudioSessionType() },
        });
      } catch (error) {
        traceVoice("audio-session", "mode-failed", {
          details: {
            mode,
            previousType,
            currentType: browserAudioSessionType(),
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
    },
    [traceVoice],
  );

  const releaseAudioSession = useCallback((): void => {
    const previousType = browserAudioSessionType();
    audioSessionLeaseRef.current?.release();
    audioSessionLeaseRef.current = null;
    traceVoice("audio-session", "released", {
      details: { previousType, currentType: browserAudioSessionType() },
    });
  }, [traceVoice]);

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
          await stopCapture();
          break;
        case "beginListening":
          if (shouldCaptureNow()) {
            await beginListening(true);
          } else {
            await stopCapture();
            syncCapturePhaseWithAgentState();
          }
          break;
        case "playCue":
          await preparePlayback();
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
          await preparePlayback();
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
          traceVoice("runtime", "user-text-submitted", {
            details: { chars: effect.text.length, messageId: effect.messageId },
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
          releaseAudioSession();
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

  const scheduleApprovalSpeech = useEventCallback((approval: ToolApprovalRequest): void => {
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
  });

  const sendMachineEvent = useEventCallback(async (event: VoicePilotEvent): Promise<void> => {
    const machine = ensureSessionMachine();
    const previousPhase = machine.getPhase();
    const transition = machine.send(event);
    const nextPhase = machine.getPhase();
    traceVoice("state-machine", "transition", {
      details: {
        input: event.type,
        previousPhase,
        nextPhase,
        effectCount: transition.effects.length,
      },
    });
    const defersListeningPhase = transition.effects.some(
      (effect) => effect.type === "beginListening",
    );
    if (!defersListeningPhase) {
      useVoicePilotStore.getState().setPhase(sessionId, nextPhase);
    }
    await dispatchEffects(transition.effects);
    if (defersListeningPhase && voicePilotEnabled() && machine.getPhase() === nextPhase) {
      useVoicePilotStore.getState().setPhase(sessionId, nextPhase);
    }
  });

  const voicePilotEnabled = useEventCallback((): boolean => {
    return Boolean(useVoicePilotStore.getState().bySessionId[sessionId]?.enabled);
  });

  const currentPilotPhase = useEventCallback((): VoicePilotState["phase"] => {
    return (
      sessionMachineRef.current?.getPhase() ??
      useVoicePilotStore.getState().bySessionId[sessionId]?.phase ??
      pilotRef.current.phase
    );
  });

  const shouldCaptureNow = useEventCallback((): boolean => {
    const phase = currentPilotPhase();
    if (phase === "approval") {
      return Boolean(firstPendingApproval(approvalsRef.current));
    }
    if (phase === "listening") {
      return !agentBusyRef.current && !firstPendingApproval(approvalsRef.current);
    }
    return false;
  });

  function hasQueuedOrActiveSpeech(): boolean {
    return Boolean(activeSpeechRef.current) || speechQueueRef.current.length > 0;
  }

  const syncCapturePhaseWithAgentState = useEventCallback((): void => {
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
  });

  const acceptsAsrInput = useCallback((): boolean => {
    const phase = currentPilotPhase();
    if (phase === "approval") return Boolean(firstPendingApproval(approvalsRef.current));
    if (phase === "listening") {
      return !agentBusyRef.current && !firstPendingApproval(approvalsRef.current);
    }
    return false;
  }, [currentPilotPhase]);

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

  const stopCapture = useCallback(
    async (originatingStartGeneration?: number): Promise<void> => {
      const attemptId = asrAttemptIdRef.current;
      const generation = captureGenerationRef.current + 1;
      captureGenerationRef.current = generation;
      const speechInput = speechInputRef.current;
      speechInputRef.current = null;
      speechInput?.cancel();
      if (attemptId) {
        traceVoice("capture", "stopped", {
          attemptId,
          details: speechInput ? { ...speechInput.snapshot() } : undefined,
        });
      }
      asrAttemptIdRef.current = null;
      const store = useVoicePilotStore.getState();
      store.setActivityLevel(sessionId, 0);
      store.clearWaveform(sessionId);
      const inFlightStart = listeningStartRef.current;
      if (inFlightStart && inFlightStart.generation !== originatingStartGeneration) {
        traceVoice("capture", "startup-cancelled", {
          details: { generation: inFlightStart.generation },
        });
        await inFlightStart.promise.catch(() => undefined);
        traceVoice("capture", "startup-settled", {
          details: { generation: inFlightStart.generation },
        });
      }
      const capture = captureRef.current;
      captureRef.current = null;
      if (capture) {
        traceVoice("capture", "release-started", { attemptId });
        const previousShutdown = captureShutdownRef.current;
        const shutdown = (async () => {
          await previousShutdown.catch(() => undefined);
          await capture.stop();
        })();
        captureShutdownRef.current = shutdown;
        try {
          await shutdown;
          traceVoice("capture", "release-finished", { attemptId });
        } catch (error) {
          traceVoice("capture", "release-failed", {
            attemptId,
            details: { error: error instanceof Error ? error.message : String(error) },
          });
          throw error;
        }
      } else {
        await captureShutdownRef.current;
      }
      if (
        audioSessionLeaseRef.current &&
        captureGenerationRef.current === generation &&
        !captureRef.current
      ) {
        setAudioSessionMode("playback");
      }
    },
    [sessionId, setAudioSessionMode, traceVoice],
  );

  const preparePlayback = useCallback(async (): Promise<void> => {
    await captureShutdownRef.current;
    setAudioSessionMode("playback");
    const refreshRequired = playbackRefreshRequiredRef.current;
    traceVoice("playback", "prepare-started", {
      details: {
        refreshAfterCapture: refreshRequired,
        ...playerRef.current?.snapshot(),
      },
    });
    if (refreshRequired) {
      await voicePlaybackContext.reactivateAfterCapture();
      playbackRefreshRequiredRef.current = false;
    } else {
      await voicePlaybackContext.prepare();
    }
    traceVoice("playback", "prepare-finished", {
      details: {
        refreshedAfterCapture: refreshRequired,
        ...playerRef.current?.snapshot(),
      },
    });
  }, [setAudioSessionMode, traceVoice]);

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

  const beginListening = useEventCallback((playStartCue: boolean): Promise<void> => {
    if (captureRef.current) return Promise.resolve();
    const inFlightStart = listeningStartRef.current;
    if (inFlightStart) {
      if (inFlightStart.generation === captureGenerationRef.current) {
        return inFlightStart.promise;
      }
      return inFlightStart.promise
        .catch(() => undefined)
        .then(() => {
          if (!voicePilotEnabled() || !shouldCaptureNow()) return;
          return beginListening(playStartCue);
        });
    }

    const generation = captureGenerationRef.current + 1;
    captureGenerationRef.current = generation;
    traceVoice("capture", "preparing", {
      details: { generation, playStartCue },
    });
    const store = useVoicePilotStore.getState();
    store.setActivityLevel(sessionId, 0);
    store.clearWaveform(sessionId);

    const startPromise = (async () => {
      await captureShutdownRef.current;
      if (captureGenerationRef.current !== generation || !shouldCaptureNow()) return;
      const transport = asrTransportRef.current;
      if (!transport) throw new Error("语音识别连接不可用");
      setAudioSessionMode("capture");
      playbackRefreshRequiredRef.current = true;

      const speechInput = new SpeechInputPipeline({
        preRollBytes: Math.ceil((SPEECH_PRE_ROLL_MS * MU_LAW_BYTES_PER_SECOND) / 1000),
        openStream: async () => {
          if (captureGenerationRef.current !== generation || !shouldCaptureNow()) {
            throw new Error("语音识别已取消");
          }
          const attemptId = `${sessionId}-asr-${Date.now()}-${generation}`;
          asrAttemptIdRef.current = attemptId;
          traceVoice("asr", "speech-attempt-starting", { attemptId });
          const attempt = await transport.startAttempt({
            sessionId,
            attemptId,
            sampleRate: ASR_SAMPLE_RATE,
            encoding: "mulaw",
          });
          if (captureGenerationRef.current !== generation || !shouldCaptureNow()) {
            attempt.abort();
            throw new Error("语音识别已取消");
          }
          traceVoice("asr", "provider-ready", { attemptId });
          return attempt;
        },
        onError: (error) => {
          traceVoice("asr", "speech-attempt-failed", {
            attemptId: asrAttemptIdRef.current,
            details: { error: errorMessage(error, "语音识别失败") },
          });
          reportProviderError(errorMessage(error, "语音识别失败"));
        },
      });
      speechInputRef.current = speechInput;

      const source = resolveVoiceSpeechSource();
      const capture = await createSpeechCapture({
        source,
        onFrame: ({ pcm, activityLevel }) => {
          if (captureGenerationRef.current !== generation || !acceptsAsrInput()) return;
          if (captureMuted()) {
            useVoicePilotStore.getState().setActivityLevel(sessionId, 0);
            return;
          }
          const currentStore = useVoicePilotStore.getState();
          currentStore.setActivityLevel(sessionId, activityLevel);
          currentStore.appendWaveform(
            sessionId,
            int16PcmEnvelope(pcm, WAVEFORM_BINS_PER_PCM_CHUNK),
          );
          speechInput.pushFrame(encodePcm16ToMuLaw(pcm));
        },
        onSpeechStart: () => {
          traceVoice("capture", "speech-start", {
            details: { ...speechInput.snapshot() },
          });
          speechInput.speechStarted();
        },
        onSpeechEnd: () => {
          traceVoice("capture", "speech-end", {
            attemptId: asrAttemptIdRef.current,
            details: { ...speechInput.snapshot() },
          });
          speechInput.speechFinished();
        },
      });
      if (captureGenerationRef.current !== generation || !shouldCaptureNow()) {
        speechInput.cancel();
        if (speechInputRef.current === speechInput) speechInputRef.current = null;
        await capture.stop();
        return;
      }
      captureRef.current = capture;
      traceVoice("capture", "source-ready", {
        details: { source: capture.source, sampleRate: ASR_SAMPLE_RATE },
      });

      if (playStartCue) {
        await preparePlayback();
        await playEarcon("listening-start");
      }
      if (
        captureGenerationRef.current !== generation ||
        captureRef.current !== capture ||
        !shouldCaptureNow()
      ) {
        if (captureGenerationRef.current === generation) await stopCapture(generation);
        return;
      }
      if (playStartCue) {
        setAudioSessionMode("capture");
        playbackRefreshRequiredRef.current = true;
      }
      await capture.start();
      traceVoice("capture", "listening", {
        details: { source: capture.source },
      });
    })().catch(async (error: unknown) => {
      traceVoice("capture", "start-failed", {
        attemptId: asrAttemptIdRef.current,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      if (captureGenerationRef.current === generation) await stopCapture(generation);
      throw error;
    });

    const trackedPromise = startPromise.finally(() => {
      if (listeningStartRef.current?.promise === trackedPromise) {
        listeningStartRef.current = null;
      }
    });
    listeningStartRef.current = { generation, promise: trackedPromise };
    return trackedPromise;
  });

  useEffect(() => {
    if (!enabled || !asrTransportRef.current) return;
    if (!shouldCaptureNow()) {
      void stopCapture()
        .then(() => syncCapturePhaseWithAgentState())
        .catch((err: unknown) => {
          if (!voicePilotEnabled()) return;
          useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "停止语音采集失败"));
        });
      return;
    }
    void beginListening(false).catch((err: unknown) => {
      if (!voicePilotEnabled()) return;
      useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "语音识别连接不可用"));
    });
  }, [
    agentBusy,
    beginListening,
    enabled,
    sessionId,
    shouldCaptureNow,
    stopCapture,
    syncCapturePhaseWithAgentState,
    voicePilotEnabled,
  ]);

  const playEarcon = useCallback(
    async (kind: VoicePilotEarcon) => {
      const player = playerRef.current;
      if (!player) throw new Error("Voice Pilot 音频尚未准备好");
      const earcon = createVoicePilotEarcon(kind, TTS_SAMPLE_RATE);
      traceVoice("playback", "earcon-starting", {
        details: { kind, durationMs: earcon.durationMs, ...player.snapshot() },
      });
      await player.resume();
      const queuedMs = player.enqueue(earcon.pcm);
      const waitMs = Number.isFinite(queuedMs) ? queuedMs : earcon.durationMs;
      const guardedWaitMs = Math.max(0, waitMs) + SYSTEM_AUDIO_CAPTURE_GUARD_MS;
      muteCaptureFor(guardedWaitMs);
      await sleep(guardedWaitMs);
      traceVoice("playback", "earcon-finished", {
        details: { kind, ...player.snapshot() },
      });
    },
    [muteCaptureFor, traceVoice],
  );

  const cleanupRuntime = useCallback(() => {
    traceVoice("runtime", "cleanup-started");
    const captureShutdown = stopCapture();
    turnBufferRef.current?.dispose();
    playerRef.current?.stop();
    captureMutedUntilRef.current = 0;
    ttsPlaybackEndAtRef.current = 0;
    const asrTransport = asrTransportRef.current;
    const tts = ttsRef.current;
    asrTransportRef.current = null;
    ttsRef.current = null;
    asrTransport?.dispose();
    tts?.close();
    turnBufferRef.current = null;
    playerRef.current = null;
    pendingSpeechRef.current = [];
    speechQueueRef.current = [];
    activeSpeechRef.current = null;
    activeTtsRequestIdRef.current = null;
    ttsStatsRef.current.clear();
    scheduledApprovalRequestIdsRef.current.clear();
    discardVoicePartialBubble();
    sessionMachineRef.current = null;
    void captureShutdown.finally(releaseAudioSession);
    traceVoice("runtime", "cleanup-finished");
  }, [discardVoicePartialBubble, releaseAudioSession, stopCapture, traceVoice]);

  const sendSpeechNow = useCallback(
    (socket: WebSocket, text: string) => {
      const requestId = `${sessionId}-tts-${Date.now()}`;
      ttsStatsRef.current.set(requestId, {
        requestId,
        requestedAt: performance.now(),
        startedAt: null,
        firstPcmAt: null,
        pcmBytes: 0,
        pcmChunks: 0,
      });
      traceVoice("tts", "request-sent", {
        requestId,
        details: { textChars: text.length, socketState: socket.readyState },
      });
      socket.send(
        JSON.stringify({
          type: "speak",
          requestId,
          text,
        }),
      );
    },
    [sessionId, traceVoice],
  );

  const flushPendingSpeech = useCallback(async (): Promise<void> => {
    const socket = ttsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (pendingSpeechRef.current.length === 0) return;
    await preparePlayback();
    if (!voicePilotEnabled() || ttsRef.current !== socket) return;
    const pending = pendingSpeechRef.current.splice(0);
    for (const text of pending) {
      sendSpeechNow(socket, text);
    }
  }, [preparePlayback, sendSpeechNow, voicePilotEnabled]);

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

  const enqueueAssistantText = useEventCallback((text: string, messageId = ""): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    traceVoice("runtime", "assistant-text-queued", {
      details: { chars: trimmed.length, messageId: messageId || null },
    });
    const key = messageId
      ? `assistant:${messageId}:${speechTextFingerprint(trimmed)}`
      : `assistant:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    enqueueSpeechItem({ kind: "assistant", key, text: trimmed, messageId });
  });

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
    [enqueueAssistantText],
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
    [discardVoicePartialBubble, sendMachineEvent, sessionId, speak],
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
      if (route.kind === "command") {
        traceVoice("runtime", "voice-command-routed", {
          details: { command: route.command.type },
        });
        // 命令路径的 cue / cap 状态由 handleCommand 触发的 machine event 管
        handleCommand(route.command);
        return;
      }
      traceVoice("runtime", "voice-text-routed", {
        details: { chars: route.text.length, approvalPromptActive: Boolean(approval) },
      });
      // 文本路径: turnIdleElapsed effect 触发 stopCapture + playCue user-end
      await sendMachineEvent({ type: "turnIdleElapsed" });
      if (!useVoicePilotStore.getState().bySessionId[sessionId]?.enabled) return;
      if (approval) {
        traceVoice("runtime", "approval-guidance-requested", {
          details: { chars: route.text.length },
        });
        discardVoicePartialBubble();
        speak(APPROVAL_DECISION_HINT);
        return;
      }
      const messageId = commitRecognizedInput(route.text);
      await sendMachineEvent({ type: "userEndCueDone", text: route.text, messageId });
    },
    [
      commitRecognizedInput,
      discardVoicePartialBubble,
      handleCommand,
      sendMachineEvent,
      sessionId,
      speak,
      traceVoice,
    ],
  );

  const handleFinalAsrText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      void sendMachineEvent({ type: "asrFinal", text: trimmed });
    },
    [sendMachineEvent],
  );

  const handleAsrAttemptError = useEventCallback((error: string, attemptId: string): void => {
    const preservedRecognizedText = turnBufferRef.current?.flushNow() ?? false;
    traceVoice("asr", "attempt-error", {
      attemptId,
      details: { error, preservedRecognizedText },
    });
    if (!preservedRecognizedText) reportProviderError(error);
  });

  function ensureVoiceRuntime(): void {
    if (turnBufferRef.current || asrTransportRef.current || ttsRef.current || playerRef.current) {
      return;
    }

    traceVoice("runtime", "creating");

    turnBufferRef.current = new VoiceTurnBuffer({
      idleTimeoutMs: configuredTurnIdleMsRef.current,
      onTurnReady: (text) => {
        void handleCompletedVoiceTurn(text);
      },
    });
    const asrTransport = new VoiceAsrTransport({
      url: toVoiceWsUrl("/voice/asr"),
      onPartial: (text, attemptId) => {
        if (!acceptsAsrInput()) return;
        traceVoice("asr", "partial-received", {
          attemptId,
          details: { chars: text.length },
        });
        turnBufferRef.current?.appendPartial(text);
        upsertVoicePartialBubble();
      },
      onFinal: (text, attemptId) => {
        traceVoice("asr", "final-received", {
          attemptId,
          details: { chars: text.length },
        });
        if (!acceptsAsrInput()) return;
        handleFinalAsrText(text);
      },
      onAttemptError: (error, attemptId) => {
        handleAsrAttemptError(error, attemptId);
      },
      onTransportError: (error) => {
        traceVoice("asr", "transport-error", {
          attemptId: asrAttemptIdRef.current,
          details: { error },
        });
        reportProviderError(error);
      },
      onTrace: (event, details) => {
        traceVoice("asr", event, {
          attemptId: asrAttemptIdRef.current,
          details: toVoiceTraceDetails(details),
        });
      },
    });
    const tts = new WebSocket(toVoiceWsUrl("/voice/tts"));
    tts.binaryType = "arraybuffer";
    asrTransportRef.current = asrTransport;
    ttsRef.current = tts;
    const player = new PcmStreamPlayer(voicePlaybackContext.get(), TTS_SAMPLE_RATE, {
      onActivityLevel: (level) => {
        if (playerRef.current !== player) return;
        useVoicePilotStore.getState().setActivityLevel(sessionId, level);
      },
      onPlaybackChunk: (chunk) => {
        if (playerRef.current !== player) return;
        useVoicePilotStore
          .getState()
          .appendWaveform(sessionId, int16PcmEnvelope(chunk, WAVEFORM_BINS_PER_PCM_CHUNK));
      },
      onPlaybackEvent: (playbackEvent: PcmStreamPlayerEvent) => {
        const details = {
          contextState: playbackEvent.contextState,
          contextTime: playbackEvent.contextTime,
          nextStartTime: playbackEvent.nextStartTime,
          queuedMs: playbackEvent.queuedMs,
          ...(typeof playbackEvent.bytes === "number" ? { bytes: playbackEvent.bytes } : {}),
          ...(typeof playbackEvent.durationMs === "number"
            ? { durationMs: playbackEvent.durationMs }
            : {}),
          ...(playbackEvent.error ? { error: playbackEvent.error } : {}),
        };
        traceVoice("playback", playbackEvent.event, {
          requestId: activeTtsRequestIdRef.current,
          details,
        });
      },
    });
    playerRef.current = player;
    void asrTransport
      .connect()
      .then(() => {
        if (asrTransportRef.current !== asrTransport || !voicePilotEnabled()) return;
        traceVoice("asr", "websocket-open");
        return sendMachineEvent({ type: "asrReady" });
      })
      .catch((error: unknown) => {
        if (asrTransportRef.current !== asrTransport || !voicePilotEnabled()) return;
        reportProviderError(errorMessage(error, "语音识别连接不可用"));
      });
    tts.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        const chunk = new Uint8Array(event.data);
        const requestId = activeTtsRequestIdRef.current;
        const stats = requestId ? ttsStatsRef.current.get(requestId) : null;
        if (stats) {
          if (stats.firstPcmAt === null) {
            stats.firstPcmAt = performance.now();
            traceVoice("tts", "first-pcm-received", {
              requestId,
              details: {
                firstPcmMs: stats.firstPcmAt - stats.requestedAt,
                bytes: chunk.byteLength,
                ...player.snapshot(),
              },
            });
          }
          stats.pcmBytes += chunk.byteLength;
          stats.pcmChunks += 1;
        }
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
      if (msg.type === "started") {
        const requestId = msg.requestId ?? null;
        activeTtsRequestIdRef.current = requestId;
        const stats = requestId ? ttsStatsRef.current.get(requestId) : null;
        if (stats) stats.startedAt = performance.now();
        traceVoice("tts", "provider-started", {
          requestId,
          details: { startedMs: stats ? performance.now() - stats.requestedAt : 0 },
        });
        return;
      }
      if (msg.type === "finished") {
        const requestId = msg.requestId ?? activeTtsRequestIdRef.current;
        const stats = requestId ? ttsStatsRef.current.get(requestId) : null;
        traceVoice("tts", "provider-finished", {
          requestId,
          details: {
            durationMs: stats ? performance.now() - stats.requestedAt : 0,
            pcmBytes: stats?.pcmBytes ?? 0,
            pcmChunks: stats?.pcmChunks ?? 0,
            ...player.snapshot(),
          },
        });
        void (async () => {
          const queuedPlaybackMs = Math.max(0, ttsPlaybackEndAtRef.current - performance.now());
          if (queuedPlaybackMs > 0) {
            await sleep(queuedPlaybackMs);
          }
          ttsPlaybackEndAtRef.current = 0;
          const store = useVoicePilotStore.getState();
          store.setActivityLevel(sessionId, 0);
          store.clearWaveform(sessionId);
          await sendMachineEvent({ type: "ttsFinished" });
          if (requestId) ttsStatsRef.current.delete(requestId);
          if (activeTtsRequestIdRef.current === requestId) {
            activeTtsRequestIdRef.current = null;
          }
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
        traceVoice("tts", "provider-error", {
          requestId: msg.requestId ?? activeTtsRequestIdRef.current,
          details: {
            errorCode: msg.errorCode ?? null,
            error: msg.error ?? "语音播报失败",
            ...player.snapshot(),
          },
        });
        reportProviderError(msg.error ?? "语音播报失败");
      }
      // `closed` is a provider-socket lifecycle notification. Bailian may close the
      // upstream TTS socket normally after a finished request; active failures are
      // reported through `error` above, while browser websocket failures still hit
      // the native `close` listener below.
    });
    tts.addEventListener("close", (event) => {
      if (ttsRef.current !== tts || !voicePilotEnabled()) return;
      traceVoice("tts", "websocket-closed", {
        requestId: activeTtsRequestIdRef.current,
        details: { code: event.code, reason: event.reason, wasClean: event.wasClean },
      });
      reportProviderError("语音播报连接已断开");
    });
    tts.addEventListener("error", () => {
      if (ttsRef.current !== tts || !voicePilotEnabled()) return;
      traceVoice("tts", "websocket-error", {
        requestId: activeTtsRequestIdRef.current,
      });
      reportProviderError("语音播报连接不可用");
    });
    tts.addEventListener("open", () => {
      traceVoice("tts", "websocket-open");
      void sendMachineEvent({ type: "ttsReady" }).catch((err: unknown) => {
        useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "语音播报连接不可用"));
      });
      void flushPendingSpeech().catch((err: unknown) => {
        if (!voicePilotEnabled()) return;
        useVoicePilotStore.getState().setError(sessionId, errorMessage(err, "准备语音播报失败"));
      });
    });
    traceVoice("runtime", "created", {
      details: { playbackContextState: player.snapshot().contextState },
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
    [enqueueAssistantText, sessionId],
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
    scheduleApprovalSpeech,
    sendMachineEvent,
    sessionId,
    speakAssistantMessage,
    syncCapturePhaseWithAgentState,
  ]);

  return null;
}
