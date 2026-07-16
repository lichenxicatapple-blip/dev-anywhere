import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSpeechCapture,
  sendEnvelope,
  sendControl,
  requestVoiceConfig,
  requestVoiceSummary,
  wakeEnable,
  wakeDisable,
  playerEnqueue,
  playerResume,
  playerStop,
  setPlayerActivityHandler,
  setPlayerChunkHandler,
  emitPlayerActivity,
  emitPlayerChunk,
  voiceAudioSessionAcquire,
  voiceAudioSessionSetMode,
  voiceAudioSessionRelease,
  voicePlaybackContextGet,
  voicePlaybackContextPrepare,
  voicePlaybackContextReactivate,
} = vi.hoisted(() => {
  const activity = { handler: null as ((level: number) => void) | null };
  const playbackChunk = { handler: null as ((chunk: Uint8Array) => void) | null };
  return {
    createSpeechCapture: vi.fn(),
    sendEnvelope: vi.fn(),
    sendControl: vi.fn(),
    requestVoiceConfig: vi.fn(),
    requestVoiceSummary: vi.fn(),
    wakeEnable: vi.fn(),
    wakeDisable: vi.fn(),
    playerEnqueue: vi.fn(),
    playerResume: vi.fn(),
    playerStop: vi.fn(),
    setPlayerActivityHandler: (next: ((level: number) => void) | null) => {
      activity.handler = next;
    },
    setPlayerChunkHandler: (next: ((chunk: Uint8Array) => void) | null) => {
      playbackChunk.handler = next;
    },
    emitPlayerActivity: (level: number) => {
      activity.handler?.(level);
    },
    emitPlayerChunk: (chunk: Uint8Array) => {
      playbackChunk.handler?.(chunk);
    },
    voiceAudioSessionAcquire: vi.fn(),
    voiceAudioSessionSetMode: vi.fn(),
    voiceAudioSessionRelease: vi.fn(),
    voicePlaybackContextGet: vi.fn(),
    voicePlaybackContextPrepare: vi.fn(),
    voicePlaybackContextReactivate: vi.fn(),
  };
});

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    requestVoiceConfig,
    requestVoiceSummary,
    sendEnvelope,
    sendControl,
  },
  wsManagerRef: null,
}));

vi.mock("@/hooks/use-screen-wake-lock", () => ({
  useScreenWakeLockScope: () => ({
    active: false,
    pending: false,
    supported: true,
    enable: wakeEnable,
    disable: wakeDisable,
    toggle: vi.fn(),
  }),
}));

vi.mock("@/voice/speech-capture", () => ({
  createSpeechCapture,
  resolveVoiceSpeechSource: () => ({ kind: "microphone" }),
}));

vi.mock("@/voice/browser-audio-session", () => ({
  voiceAudioSession: {
    acquire: voiceAudioSessionAcquire,
  },
}));

vi.mock("@/voice/voice-playback-context", () => ({
  voicePlaybackContext: {
    get: voicePlaybackContextGet,
    prepare: voicePlaybackContextPrepare,
    reactivateAfterCapture: voicePlaybackContextReactivate,
  },
}));

vi.mock("@/voice/pcm-stream-player", () => ({
  PcmStreamPlayer: class {
    constructor(
      _context: AudioContext,
      _sampleRate?: number,
      options?: {
        onActivityLevel?: (level: number) => void;
        onPlaybackChunk?: (chunk: Uint8Array) => void;
        onPlaybackEvent?: (event: unknown) => void;
      },
    ) {
      setPlayerActivityHandler(options?.onActivityLevel ?? null);
      setPlayerChunkHandler(options?.onPlaybackChunk ?? null);
    }

    enqueue = playerEnqueue;
    resume = playerResume;
    stop = playerStop;
    snapshot = () => ({
      contextState: "running",
      contextTime: 0,
      nextStartTime: 0,
      queuedMs: 0,
    });
  },
}));

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  static autoAsrReady = true;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  asrAttemptId: string | null = null;
  pendingAsrMessages: unknown[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sent.push(data);
    const parsed = typeof data === "string" ? JSON.parse(data) : null;
    if (FakeWebSocket.autoAsrReady && this.url.includes("/voice/asr") && parsed?.type === "start") {
      this.asrAttemptId = parsed.attemptId as string;
      queueMicrotask(() => {
        if (this.readyState === FakeWebSocket.OPEN) {
          this.emitJson({ type: "ready", attemptId: this.asrAttemptId });
          for (const payload of this.pendingAsrMessages.splice(0)) this.emitJson(payload);
        }
      });
    } else if (this.url.includes("/voice/asr") && parsed?.type === "start") {
      this.asrAttemptId = parsed.attemptId as string;
    }
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }

  emitJson(payload: unknown): void {
    if (this.url.includes("/voice/asr") && !this.asrAttemptId) {
      this.pendingAsrMessages.push(payload);
      return;
    }
    const message =
      this.url.includes("/voice/asr") &&
      payload &&
      typeof payload === "object" &&
      !("attemptId" in payload) &&
      this.asrAttemptId
        ? { ...payload, attemptId: this.asrAttemptId }
        : payload;
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

function asrSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.find((ws) => ws.url.includes("/voice/asr"));
  if (!socket) throw new Error("ASR socket was not created");
  return socket;
}

function ttsSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.find((ws) => ws.url.includes("/voice/tts"));
  if (!socket) throw new Error("TTS socket was not created");
  return socket;
}

function socketControlTypes(socket: FakeWebSocket): string[] {
  return socket.sent
    .filter((item): item is string => typeof item === "string")
    .map((item) => JSON.parse(item).type as string);
}

interface SpeechCaptureCallbacks {
  onFrame: (frame: { pcm: Uint8Array; speechProbability: number; activityLevel: number }) => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

function speechCaptureCallbacks(callIndex = createSpeechCapture.mock.calls.length - 1) {
  const callbacks = createSpeechCapture.mock.calls[callIndex]?.[0] as
    | SpeechCaptureCallbacks
    | undefined;
  if (!callbacks) throw new Error("Speech capture callbacks were not created");
  return callbacks;
}

function emitMicFrame(callIndex = createSpeechCapture.mock.calls.length - 1): void {
  speechCaptureCallbacks(callIndex).onFrame({
    pcm: new Uint8Array([0xff, 0x7f, 0xff, 0x7f, 0x00, 0x40, 0x00, 0x40]),
    speechProbability: 0.9,
    activityLevel: 0.8,
  });
}

function emitMicSpeechChunk(callIndex = createSpeechCapture.mock.calls.length - 1): void {
  emitMicFrame(callIndex);
  speechCaptureCallbacks(callIndex).onSpeechStart();
}

function speechCaptureResult(stop = vi.fn().mockResolvedValue(undefined)) {
  return {
    source: "microphone" as const,
    start: vi.fn().mockResolvedValue(undefined),
    stop,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForListeningReady(): Promise<void> {
  await waitFor(() => expect(createSpeechCapture).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening"),
  );
}

import { VoicePilotController } from "./voice-pilot-controller";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import {
  clearVoicePilotDiagnostics,
  getVoicePilotDiagnostics,
} from "@/voice/voice-pilot-diagnostics";
import { useVoicePilotStore } from "@/voice/voice-pilot-store";

describe("VoicePilotController", () => {
  beforeEach(() => {
    cleanup();
    FakeWebSocket.instances = [];
    FakeWebSocket.autoAsrReady = true;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal(
      "AudioContext",
      class {
        currentTime = 0;
      },
    );
    createSpeechCapture.mockReset();
    createSpeechCapture.mockImplementation(async () => speechCaptureResult());
    sendEnvelope.mockReset();
    sendEnvelope.mockReturnValue(true);
    sendControl.mockReset();
    requestVoiceConfig.mockReset();
    requestVoiceConfig.mockResolvedValue({
      config: {
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
      },
    });
    requestVoiceSummary.mockReset();
    wakeEnable.mockReset();
    wakeEnable.mockResolvedValue(undefined);
    wakeDisable.mockReset();
    wakeDisable.mockResolvedValue(undefined);
    playerEnqueue.mockReset();
    playerEnqueue.mockReturnValue(0);
    playerResume.mockReset();
    playerResume.mockResolvedValue(undefined);
    playerStop.mockReset();
    setPlayerActivityHandler(null);
    setPlayerChunkHandler(null);
    voiceAudioSessionAcquire.mockReset();
    voiceAudioSessionSetMode.mockReset();
    voiceAudioSessionRelease.mockReset();
    voicePlaybackContextGet.mockReset();
    voicePlaybackContextGet.mockReturnValue({});
    voicePlaybackContextPrepare.mockReset();
    voicePlaybackContextPrepare.mockResolvedValue({});
    voicePlaybackContextReactivate.mockReset();
    voicePlaybackContextReactivate.mockResolvedValue({});
    voiceAudioSessionAcquire.mockReturnValue({
      setMode: voiceAudioSessionSetMode,
      release: voiceAudioSessionRelease,
    });
    clearVoicePilotDiagnostics();
    useVoicePilotStore.getState().resetAll();
    useChatStore.setState({ bySessionId: { s1: { ...EMPTY_SLICE, inputDraft: "typed draft" } } });
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
      agentStatusBySessionId: {},
      ptyStateBySessionId: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens ASR/TTS sockets and enables wake lock when Voice Pilot starts", async () => {
    const capture = speechCaptureResult();
    createSpeechCapture.mockResolvedValueOnce(capture);
    useVoicePilotStore.getState().enable("s1");

    const view = render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    expect(wakeEnable).toHaveBeenCalledTimes(1);
    expect(asrSocket().url).toContain("/voice/asr");
    expect(ttsSocket().url).toContain("/voice/tts");
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    expect(asrSocket().sent).toHaveLength(0);

    emitMicSpeechChunk();
    await waitFor(() => expect(socketControlTypes(asrSocket())).toContain("start"));
    expect(JSON.parse(asrSocket().sent[0] as string)).toMatchObject({
      type: "start",
      sessionId: "s1",
      sampleRate: 16000,
      encoding: "mulaw",
    });
    expect(createSpeechCapture).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening"),
    );
    expect(voiceAudioSessionAcquire).toHaveBeenCalledWith("capture");
    expect(voiceAudioSessionSetMode.mock.calls.slice(0, 2)).toEqual([["playback"], ["capture"]]);
    expect(playerEnqueue.mock.invocationCallOrder[0]).toBeLessThan(
      capture.start.mock.invocationCallOrder[0],
    );

    view.unmount();
    await waitFor(() => expect(voiceAudioSessionRelease).toHaveBeenCalledTimes(1));
  });

  it("releases voice resources in the background and resumes only after an explicit request", async () => {
    const firstStop = vi.fn().mockResolvedValue(undefined);
    const secondStop = vi.fn().mockResolvedValue(undefined);
    createSpeechCapture
      .mockResolvedValueOnce(speechCaptureResult(firstStop))
      .mockResolvedValueOnce(speechCaptureResult(secondStop));
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("suspended"),
    );
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(playerStop).toHaveBeenCalled();
    expect(wakeDisable).toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    expect(createSpeechCapture).toHaveBeenCalledTimes(1);
    expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("suspended");

    act(() => {
      useVoicePilotStore.getState().requestResume("s1");
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(4));
    FakeWebSocket.instances[2]?.open();
    FakeWebSocket.instances[3]?.open();
    await waitFor(() => expect(createSpeechCapture).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening"),
    );
  });

  it("does not create voice sockets when config returns after the page was hidden", async () => {
    let resolveConfig:
      | ((value: Awaited<ReturnType<typeof requestVoiceConfig>>) => void)
      | undefined;
    requestVoiceConfig.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("suspended"),
    );

    resolveConfig?.({
      config: {
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
      },
    });
    await flushMicrotasks();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(createSpeechCapture).not.toHaveBeenCalled();
    expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("suspended");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("keeps silence local and flushes speech only after the ASR provider is ready", async () => {
    FakeWebSocket.autoAsrReady = false;
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const asr = asrSocket();
    asr.open();
    ttsSocket().open();
    await waitForListeningReady();

    emitMicFrame(0);
    expect(socketControlTypes(asr)).toEqual([]);
    expect(asr.sent.filter((item) => item instanceof Uint8Array)).toHaveLength(0);
    speechCaptureCallbacks(0).onSpeechStart();
    emitMicFrame(0);
    await waitFor(() => expect(socketControlTypes(asr)).toEqual(["start"]));
    expect(asr.sent.filter((item) => item instanceof Uint8Array)).toHaveLength(0);

    asr.emitJson({ type: "ready" });
    await waitFor(() =>
      expect(asr.sent.filter((item) => item instanceof Uint8Array).length).toBeGreaterThanOrEqual(
        2,
      ),
    );
    expect(playerResume).toHaveBeenCalledTimes(1);
    expect(useVoicePilotStore.getState().bySessionId.s1?.waveform.length).toBeGreaterThan(0);
  });

  it("rearms the speech pipeline after an empty ASR attempt without replacing capture", async () => {
    const firstStop = vi.fn().mockResolvedValue(undefined);
    createSpeechCapture.mockResolvedValueOnce(speechCaptureResult(firstStop));
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const asr = asrSocket();
    asr.open();
    ttsSocket().open();
    await waitForListeningReady();

    emitMicSpeechChunk(0);
    speechCaptureCallbacks(0).onSpeechEnd();
    await waitFor(() => expect(socketControlTypes(asr)).toEqual(["start", "stop"]));
    asr.emitJson({ type: "closed", code: 1000, reason: "empty" });

    await waitFor(() =>
      expect(
        getVoicePilotDiagnostics().some((entry) => entry.event === "rearmed-after-empty-attempt"),
      ).toBe(true),
    );
    expect(firstStop).not.toHaveBeenCalled();
    expect(createSpeechCapture).toHaveBeenCalledTimes(1);
    expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
      enabled: true,
      phase: "listening",
      error: null,
    });

    emitMicSpeechChunk(0);
    await waitFor(() => expect(socketControlTypes(asr)).toEqual(["start", "stop", "start"]));
  });

  it("drives the Voice Pilot activity meter from microphone and speech PCM", async () => {
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    emitMicFrame(0);
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.activityLevel).toBeGreaterThan(0),
    );

    ttsSocket().dispatchEvent(
      new MessageEvent("message", { data: new Uint8Array([0xff, 0x7f, 0x00, 0x40]).buffer }),
    );
    emitPlayerActivity(0.42);
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.activityLevel).toBeGreaterThan(0),
    );

    ttsSocket().emitJson({ type: "finished" });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.activityLevel).toBe(0),
    );
  });

  it("adds speech waveform data only when its PCM chunk reaches playback", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    useVoicePilotStore.getState().clearWaveform("s1");
    const chunk = new Uint8Array([0xff, 0x7f, 0x00, 0x40]);

    ttsSocket().dispatchEvent(new MessageEvent("message", { data: chunk.buffer }));
    expect(useVoicePilotStore.getState().bySessionId.s1?.waveform).toEqual([]);

    emitPlayerChunk(chunk);
    expect(useVoicePilotStore.getState().bySessionId.s1?.waveform.length).toBeGreaterThan(0);
  });

  it("stops microphone capture when the ASR provider reports an error", async () => {
    const stopCapture = vi.fn();
    createSpeechCapture.mockResolvedValueOnce(speechCaptureResult(stopCapture));
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "error", error: "ASR disconnected" });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        phase: "error",
        error: "ASR disconnected",
      }),
    );
    expect(stopCapture).toHaveBeenCalledTimes(1);
  });

  it("submits Provider text already recognized before an active ASR attempt fails", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={10_000} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const asr = asrSocket();
    asr.open();
    ttsSocket().open();
    await waitForListeningReady();
    emitMicSpeechChunk();
    await waitFor(() => expect(socketControlTypes(asr)).toContain("start"));
    asr.emitJson({ type: "partial", text: "请检查项目状态" });
    asr.emitJson({ type: "error", error: "ASR disconnected" });

    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(sendEnvelope.mock.calls[0]?.[0]).toMatchObject({
      type: "user_input",
      payload: { text: "请检查项目状态" },
    });
    expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
      phase: "waiting",
      error: null,
    });
  });

  it("ignores late startup failures after Voice Pilot is disabled", async () => {
    const rejectWakeLock: Array<(error: Error) => void> = [];
    wakeEnable.mockReturnValueOnce(
      new Promise<undefined>((_resolve, reject) => {
        rejectWakeLock.push(reject);
      }),
    );
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(wakeEnable).toHaveBeenCalledTimes(1));
    act(() => {
      useVoicePilotStore.getState().disable("s1");
    });
    rejectWakeLock[0]?.(new Error("wake lock failed late"));

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        enabled: false,
        phase: "idle",
        error: null,
      }),
    );
  });

  it("starts a fresh ASR session after each spoken reply so a second utterance is captured", async () => {
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    createSpeechCapture
      .mockResolvedValueOnce(speechCaptureResult(firstStop))
      .mockResolvedValueOnce(speechCaptureResult(secondStop));
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const asr = asrSocket();
    const tts = ttsSocket();
    asr.open();
    tts.open();
    await waitForListeningReady();
    emitMicSpeechChunk();
    asr.emitJson({ type: "final", text: "第一轮" });

    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(socketControlTypes(asr)).toEqual(["start", "stop"]);

    useChatStore.getState().appendAssistantText("s1", "收到。");
    useChatStore.getState().markTurnComplete("s1");
    act(() => {
      useSessionStore.getState().updateSessionState("s1", "idle");
    });
    await waitFor(() =>
      expect(
        tts.sent.some((item) => typeof item === "string" && JSON.parse(item).type === "speak"),
      ).toBe(true),
    );

    tts.emitJson({ type: "finished", requestId: "reply-1" });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening"),
    );
    expect(createSpeechCapture).toHaveBeenCalledTimes(2);
    expect(socketControlTypes(asr)).toEqual(["start", "stop"]);

    const binaryMessageCount = asr.sent.filter((item) => item instanceof Uint8Array).length;
    emitMicSpeechChunk();
    await waitFor(() =>
      expect(asr.sent.filter((item) => item instanceof Uint8Array).length).toBeGreaterThan(
        binaryMessageCount,
      ),
    );
    expect(socketControlTypes(asr)).toEqual(["start", "stop", "start"]);
  });

  it("does not resume microphone capture while the agent session is still working", async () => {
    createSpeechCapture
      .mockResolvedValueOnce(speechCaptureResult(vi.fn()))
      .mockResolvedValueOnce(speechCaptureResult(vi.fn()));
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const asr = asrSocket();
    const tts = ttsSocket();
    asr.open();
    tts.open();
    await waitForListeningReady();
    emitMicSpeechChunk();
    asr.emitJson({ type: "final", text: "查一下项目状态" });
    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(useSessionStore.getState().sessions[0]?.state).toBe("working");

    useChatStore.getState().appendAssistantText("s1", "我先检查一下。");
    useChatStore.getState().markTurnComplete("s1");
    await waitFor(() => {
      const speaks = tts.sent
        .map((item) => (typeof item === "string" ? JSON.parse(item) : null))
        .filter((item) => item?.type === "speak");
      expect(speaks[0]?.text).toBe("我先检查一下。");
    });

    tts.emitJson({ type: "finished", requestId: "reply-1" });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("waiting"),
    );
    expect(createSpeechCapture).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionStore.getState().updateSessionState("s1", "idle");
    });
    await waitFor(() => expect(createSpeechCapture).toHaveBeenCalledTimes(2));
  });

  it("waits when agent status is thinking even if the session state has not flipped yet", async () => {
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    createSpeechCapture
      .mockResolvedValueOnce(speechCaptureResult(firstStop))
      .mockResolvedValueOnce(speechCaptureResult(secondStop));
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening"),
    );

    act(() => {
      useSessionStore.getState().setAgentStatus("s1", {
        provider: "claude",
        phase: "thinking",
        seq: 1,
        updatedAt: 100,
      });
    });

    await waitFor(() => {
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("waiting");
      expect(firstStop).toHaveBeenCalled();
    });
    expect(createSpeechCapture).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionStore.getState().setAgentStatus("s1", {
        provider: "claude",
        phase: "idle",
        seq: 2,
        updatedAt: 110,
      });
    });
    await flushMicrotasks();
    expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("waiting");
    expect(createSpeechCapture).toHaveBeenCalledTimes(1);

    act(() => {
      useChatStore.getState().markTurnComplete("s1");
    });
    await waitFor(() => {
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening");
      expect(createSpeechCapture).toHaveBeenCalledTimes(2);
    });
  });

  it("sends final ASR text as JSON input without touching the typed draft", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "请实现语音助手" });

    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(sendEnvelope.mock.calls[0][0]).toMatchObject({
      type: "user_input",
      sessionId: "s1",
      payload: { text: "请实现语音助手" },
      source: "client",
    });
    expect(useChatStore.getState().bySessionId.s1?.inputDraft).toBe("typed draft");
  });

  it("does not submit an ASR final immediately; submission waits for the turn buffer", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const asr = asrSocket();
    asr.open();
    ttsSocket().open();
    await waitForListeningReady();
    emitMicSpeechChunk();
    asr.emitJson({ type: "final", text: "嗯。" });

    expect(sendEnvelope).not.toHaveBeenCalled();
    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(sendEnvelope.mock.calls[0]?.[0]).toMatchObject({
      type: "user_input",
      sessionId: "s1",
      payload: { text: "嗯。" },
    });
  });

  it("accepts provider text without applying a second local volume threshold", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    speechCaptureCallbacks().onSpeechStart();
    asrSocket().emitJson({ type: "final", text: "请继续" });

    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(sendEnvelope.mock.calls[0]?.[0]).toMatchObject({
      payload: { text: "请继续" },
    });
  });

  it("plays a local earcon before sending recognized speech to the agent", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "执行下一步" });

    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(playerEnqueue).toHaveBeenCalled();
    expect(playerEnqueue.mock.invocationCallOrder[0]).toBeLessThan(
      sendEnvelope.mock.invocationCallOrder[0],
    );
  });

  it("waits for microphone teardown before reactivating playback", async () => {
    const finishStop: Array<() => void> = [];
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStop.push(resolve);
        }),
    );
    createSpeechCapture.mockResolvedValueOnce(speechCaptureResult(stop));
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    playerEnqueue.mockClear();
    voicePlaybackContextReactivate.mockClear();

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "执行下一步" });
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    expect(voicePlaybackContextReactivate).not.toHaveBeenCalled();
    expect(playerEnqueue).not.toHaveBeenCalled();

    finishStop[0]?.();
    await waitFor(() => expect(voicePlaybackContextReactivate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(playerEnqueue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
  });

  it("speaks completed assistant prose through TTS", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    useChatStore.getState().appendAssistantText("s1", "可以，我来处理。");
    useChatStore.getState().markTurnComplete("s1");

    await waitFor(() => {
      const sent = ttsSocket().sent.map((item) =>
        typeof item === "string" ? JSON.parse(item) : null,
      );
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "speak", text: "可以，我来处理。" }),
        ]),
      );
    });
    expect(useVoicePilotStore.getState().bySessionId.s1?.lastSpokenText).toBe("可以，我来处理。");
  });

  it("does not speak URLs from completed assistant messages", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    useChatStore
      .getState()
      .appendAssistantText(
        "s1",
        "来源：[国务院通知](https://www.gov.cn/zhengce/content/2025-11/04/content_7047098.htm)",
      );
    useChatStore.getState().markTurnComplete("s1");

    await waitFor(() => {
      const sent = ttsSocket().sent.map((item) =>
        typeof item === "string" ? JSON.parse(item) : null,
      );
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "speak", text: "来源：国务院通知" }),
        ]),
      );
    });
    expect(useVoicePilotStore.getState().bySessionId.s1?.lastSpokenText).toBe("来源：国务院通知");
  });

  it("waits for queued TTS playback before resuming microphone capture", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    const tts = ttsSocket();
    tts.open();
    await waitForListeningReady();

    useChatStore.getState().appendAssistantText("s1", "我会继续处理。");
    useChatStore.getState().markTurnComplete("s1");
    await waitFor(() => {
      const sent = tts.sent.map((item) => (typeof item === "string" ? JSON.parse(item) : null));
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "speak", text: "我会继续处理。" }),
        ]),
      );
    });

    playerEnqueue.mockReturnValueOnce(30);
    tts.dispatchEvent(
      new MessageEvent("message", { data: new Uint8Array([0xff, 0x7f, 0x00, 0x40]).buffer }),
    );
    tts.emitJson({ type: "finished" });
    await Promise.resolve();

    expect(createSpeechCapture).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(createSpeechCapture).toHaveBeenCalledTimes(2));
  });

  it("surfaces active TTS provider errors instead of remaining in speaking", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    useChatStore.getState().appendAssistantText("s1", "第二句回复。");
    useChatStore.getState().markTurnComplete("s1");
    await waitFor(() => {
      const sent = ttsSocket().sent.map((item) =>
        typeof item === "string" ? JSON.parse(item) : null,
      );
      expect(sent).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "speak", text: "第二句回复。" })]),
      );
    });

    ttsSocket().emitJson({
      type: "error",
      errorCode: "provider_closed",
      error: "Voice TTS provider closed before finishing",
    });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        phase: "error",
        error: "Voice TTS provider closed before finishing",
      }),
    );
  });

  it("ignores idle TTS provider close notifications after finished speech", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    useChatStore.getState().appendAssistantText("s1", "第二句回复。");
    useChatStore.getState().markTurnComplete("s1");
    await waitFor(() => {
      const sent = ttsSocket().sent.map((item) =>
        typeof item === "string" ? JSON.parse(item) : null,
      );
      expect(sent).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "speak", text: "第二句回复。" })]),
      );
    });

    ttsSocket().emitJson({ type: "finished" });
    ttsSocket().emitJson({ type: "closed", code: 1000, reason: "Bye" });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        enabled: true,
        error: null,
      }),
    );
  });

  it("does not speak the last historical assistant message when enabled", async () => {
    useChatStore.getState().appendAssistantText("s1", "这是打开前的历史回复。");
    useChatStore.getState().markTurnComplete("s1");
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await Promise.resolve();

    expect(
      ttsSocket()
        .sent.filter((item): item is string => typeof item === "string")
        .map((item) => JSON.parse(item)),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "speak", text: "这是打开前的历史回复。" }),
      ]),
    );
    await waitForListeningReady();

    useChatStore.getState().appendAssistantText("s1", "这是打开后的新回复。");
    useChatStore.getState().markTurnComplete("s1");

    await waitFor(() => {
      const sent = ttsSocket().sent.map((item) =>
        typeof item === "string" ? JSON.parse(item) : null,
      );
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "speak", text: "这是打开后的新回复。" }),
        ]),
      );
    });
  });

  it("waits for the ASR socket before resuming capture after early speech playback", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    ttsSocket().open();

    useChatStore.getState().appendAssistantText("s1", "启动期间的新回复。");
    useChatStore.getState().markTurnComplete("s1");
    await waitFor(() => {
      const sent = ttsSocket().sent.map((item) =>
        typeof item === "string" ? JSON.parse(item) : null,
      );
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "speak", text: "启动期间的新回复。" }),
        ]),
      );
    });

    ttsSocket().emitJson({ type: "finished" });
    await flushMicrotasks();
    expect(useVoicePilotStore.getState().bySessionId.s1?.phase).not.toBe("error");
    expect(useVoicePilotStore.getState().bySessionId.s1?.error).toBeNull();
    expect(createSpeechCapture).not.toHaveBeenCalled();

    asrSocket().open();

    await waitForListeningReady();
    expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening");
  });

  it("queues assistant speech until the TTS socket is open", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();

    useChatStore.getState().appendAssistantText("s1", "第一句回复。");
    useChatStore.getState().markTurnComplete("s1");

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.lastSpokenText).toBe("第一句回复。"),
    );
    expect(ttsSocket().sent).toHaveLength(0);
    ttsSocket().open();

    await waitFor(() => {
      const sent = ttsSocket().sent.map((item) =>
        typeof item === "string" ? JSON.parse(item) : null,
      );
      expect(sent).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "speak", text: "第一句回复。" })]),
      );
    });
  });

  it("asks the proxy for a speech summary before speaking code-heavy replies", async () => {
    requestVoiceSummary.mockResolvedValueOnce({
      sessionId: "s1",
      messageId: "summary-message",
      success: true,
      summary: "已经给出实现方案，重点检查新增文件。",
    });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();

    const codeText = "```ts\nconst ok = true;\n```";
    useChatStore.getState().appendAssistantText("s1", codeText);
    useChatStore.getState().markTurnComplete("s1");

    await waitFor(() => {
      expect(requestVoiceSummary).toHaveBeenCalledWith("s1", expect.any(String), codeText, "code");
    });
    await waitFor(() => {
      const sent = ttsSocket().sent.map((item) =>
        typeof item === "string" ? JSON.parse(item) : null,
      );
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "speak",
            text: "下面是摘要：已经给出实现方案，重点检查新增文件。",
          }),
        ]),
      );
    });
  });

  it("uses deterministic fallback speech when proxy summary fails", async () => {
    requestVoiceSummary.mockResolvedValueOnce({
      sessionId: "s1",
      messageId: "summary-message",
      success: false,
      error: "timeout",
    });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();

    const tableText = "| 文件 | 状态 |\n| --- | --- |\n| a.ts | ok |";
    useChatStore.getState().appendAssistantText("s1", tableText);
    useChatStore.getState().markTurnComplete("s1");

    await waitFor(() => {
      const sent = ttsSocket().sent.map((item) =>
        typeof item === "string" ? JSON.parse(item) : null,
      );
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "speak",
            text: expect.stringContaining("这条回复包含表格"),
          }),
        ]),
      );
    });
  });

  it("summarizes pending approval details once and asks for short approval commands", async () => {
    requestVoiceSummary.mockResolvedValueOnce({
      sessionId: "s1",
      messageId: "toolu_1",
      success: true,
      summary: "需要查看 Claude 项目记忆目录的前 50 行。",
    });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "toolu_1",
      toolName: "Bash",
      input: { command: "pnpm test" },
      status: "pending",
    });

    await waitFor(() =>
      expect(requestVoiceSummary).toHaveBeenCalledWith(
        "s1",
        "toolu_1",
        expect.stringContaining("pnpm test"),
        "approval",
      ),
    );

    await waitFor(() => {
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        phase: "approval",
        approvalRequestId: "toolu_1",
      });
      const sent = ttsSocket().sent.map((item) =>
        typeof item === "string" ? JSON.parse(item) : null,
      );
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "speak",
            text: "需要审批：需要查看 Claude 项目记忆目录的前 50 行。请说允许、始终允许或拒绝。",
          }),
        ]),
      );
      expect(
        sent.filter((item) => item?.type === "speak" && String(item.text).includes("审批")),
      ).toHaveLength(1);
      expect(
        sent.some((item) => item?.type === "speak" && String(item.text).includes("批准这次")),
      ).toBe(false);
    });

    ttsSocket().emitJson({ type: "finished", requestId: "approval-prompt" });

    await waitFor(() => {
      expect(createSpeechCapture).toHaveBeenCalledTimes(2);
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        phase: "approval",
        approvalRequestId: "toolu_1",
      });
    });
  });

  it("announces multiple pending approvals one at a time with queue context", async () => {
    requestVoiceSummary
      .mockResolvedValueOnce({
        sessionId: "s1",
        messageId: "toolu_1",
        success: true,
        summary: "需要搜索近年操作系统论文。",
      })
      .mockResolvedValueOnce({
        sessionId: "s1",
        messageId: "toolu_2",
        success: true,
        summary: "需要读取项目配置文件。",
      });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    act(() => {
      useChatStore.getState().addApprovalRequest("s1", {
        requestId: "toolu_1",
        toolName: "WebSearch",
        input: { query: "recent operating systems papers" },
        status: "pending",
      });
      useChatStore.getState().addApprovalRequest("s1", {
        requestId: "toolu_2",
        toolName: "Read",
        input: { file_path: "/tmp/package.json" },
        status: "pending",
      });
    });

    await waitFor(() => {
      const speaks = ttsSocket()
        .sent.map((item) => (typeof item === "string" ? JSON.parse(item) : null))
        .filter((item) => item?.type === "speak");
      expect(speaks[0]?.text).toBe(
        "有 2 个工具审批待处理。第 1 个，共 2 个。需要审批：需要搜索近年操作系统论文。请说允许、始终允许或拒绝。",
      );
    });

    act(() => {
      useChatStore.getState().updateApprovalStatus("s1", "toolu_1", "approved");
    });
    await waitFor(() =>
      expect(requestVoiceSummary).toHaveBeenCalledWith(
        "s1",
        "toolu_2",
        expect.stringContaining("/tmp/package.json"),
        "approval",
      ),
    );

    ttsSocket().emitJson({ type: "finished", requestId: "approval-prompt" });

    await waitFor(() => {
      const speaks = ttsSocket()
        .sent.map((item) => (typeof item === "string" ? JSON.parse(item) : null))
        .filter((item) => item?.type === "speak");
      expect(speaks.map((item) => item.text)).toContain(
        "需要审批：需要读取项目配置文件。请说允许、始终允许或拒绝。",
      );
    });
  });

  it("enters approval immediately even while the spoken approval summary is still pending", async () => {
    requestVoiceSummary.mockReturnValueOnce(new Promise(() => undefined));
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    act(() => {
      useChatStore.getState().addApprovalRequest("s1", {
        requestId: "toolu_1",
        toolName: "Bash",
        input: { command: "pnpm test" },
        status: "pending",
      });
    });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        phase: "approval",
        approvalRequestId: "toolu_1",
      }),
    );
    expect(
      ttsSocket()
        .sent.map((item) => (typeof item === "string" ? JSON.parse(item) : null))
        .some((item) => item?.type === "speak" && String(item.text).includes("需要审批")),
    ).toBe(false);
  });

  it("speaks newly visible assistant text before announcing a simultaneous approval", async () => {
    requestVoiceSummary.mockResolvedValueOnce({
      sessionId: "s1",
      messageId: "toolu_1",
      success: true,
      summary: "需要搜索最近几年操作系统顶会论文，最多返回十条结果。",
    });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    const assistantText = "我直接用网络搜索查最近几年顶会的 OS 论文与思潮。";
    act(() => {
      useChatStore.getState().appendAssistantText("s1", assistantText);
      useChatStore.getState().markTurnComplete("s1");
      useChatStore.getState().addApprovalRequest("s1", {
        requestId: "toolu_1",
        toolName: "mcp__serper__web_search",
        input: { query: "SOSP 2025 accepted papers operating systems", num: 10 },
        status: "pending",
      });
    });

    await waitFor(() => {
      const speaks = ttsSocket()
        .sent.map((item) => (typeof item === "string" ? JSON.parse(item) : null))
        .filter((item) => item?.type === "speak");
      expect(speaks[0]?.text).toBe(assistantText);
      expect(speaks).toHaveLength(1);
    });

    ttsSocket().emitJson({ type: "finished", requestId: "assistant-text" });

    await waitFor(() =>
      expect(requestVoiceSummary).toHaveBeenCalledWith(
        "s1",
        "toolu_1",
        expect.stringContaining("SOSP 2025 accepted papers"),
        "approval",
      ),
    );
    await waitFor(() => {
      const speaks = ttsSocket()
        .sent.map((item) => (typeof item === "string" ? JSON.parse(item) : null))
        .filter((item) => item?.type === "speak");
      expect(speaks[1]?.text).toBe(
        "需要审批：需要搜索最近几年操作系统顶会论文，最多返回十条结果。请说允许、始终允许或拒绝。",
      );
    });
  });

  it("speaks in-progress assistant text before announcing approval when Claude requests a tool before Stop", async () => {
    requestVoiceSummary.mockResolvedValueOnce({
      sessionId: "s1",
      messageId: "toolu_1",
      success: true,
      summary: "需要用 WebSearch 搜索近年操作系统论文和研究方向。",
    });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    const assistantText = "我用网络搜索查一下近年操作系统领域的论文和研究方向。";
    act(() => {
      useChatStore.getState().appendAssistantText("s1", assistantText);
      useChatStore.getState().addApprovalRequest("s1", {
        requestId: "toolu_1",
        toolName: "WebSearch",
        input: { query: "recent operating systems papers research directions" },
        status: "pending",
      });
    });

    await waitFor(() => {
      const speaks = ttsSocket()
        .sent.map((item) => (typeof item === "string" ? JSON.parse(item) : null))
        .filter((item) => item?.type === "speak");
      expect(speaks[0]?.text).toBe(assistantText);
      expect(speaks).toHaveLength(1);
    });

    ttsSocket().emitJson({ type: "finished", requestId: "assistant-text" });

    await waitFor(() =>
      expect(requestVoiceSummary).toHaveBeenCalledWith(
        "s1",
        "toolu_1",
        expect.stringContaining("recent operating systems papers"),
        "approval",
      ),
    );
    await waitFor(() => {
      const speaks = ttsSocket()
        .sent.map((item) => (typeof item === "string" ? JSON.parse(item) : null))
        .filter((item) => item?.type === "speak");
      expect(speaks[1]?.text).toBe(
        "需要审批：需要用 WebSearch 搜索近年操作系统论文和研究方向。请说允许、始终允许或拒绝。",
      );
    });

    act(() => {
      useChatStore.getState().markTurnComplete("s1");
    });
    await flushMicrotasks();
    const speaks = ttsSocket()
      .sent.map((item) => (typeof item === "string" ? JSON.parse(item) : null))
      .filter((item) => item?.type === "speak");
    expect(speaks.map((item) => item.text)).toEqual([
      assistantText,
      "需要审批：需要用 WebSearch 搜索近年操作系统论文和研究方向。请说允许、始终允许或拒绝。",
    ]);
  });

  it("approves pending tools with the short approval voice command after the prompt finishes", async () => {
    requestVoiceSummary.mockResolvedValueOnce({
      sessionId: "s1",
      messageId: "toolu_1",
      success: true,
      summary: "需要运行项目测试。",
    });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "toolu_1",
      toolName: "Bash",
      input: { command: "pnpm test" },
      status: "pending",
    });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("approval"),
    );

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "可以" });

    await waitFor(() => expect(sendEnvelope).not.toHaveBeenCalled());
    expect(sendControl).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        ttsSocket().sent.some(
          (item) =>
            typeof item === "string" &&
            JSON.parse(item).type === "speak" &&
            JSON.parse(item).text.includes("允许、始终允许或拒绝"),
        ),
      ).toBe(true),
    );
    ttsSocket().emitJson({ type: "finished", requestId: "approval-prompt" });
    await waitFor(() => expect(createSpeechCapture).toHaveBeenCalledTimes(2));

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "允许" });

    await waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: "tool_approve",
        sessionId: "s1",
        payload: { toolId: "toolu_1", whitelistTool: false },
      }),
    );
  });

  it("stops approval capture and waits for formal turn completion before listening again", async () => {
    const firstStop = vi.fn().mockResolvedValue(undefined);
    const approvalStop = vi.fn().mockResolvedValue(undefined);
    createSpeechCapture
      .mockResolvedValueOnce(speechCaptureResult(firstStop))
      .mockResolvedValueOnce(speechCaptureResult(approvalStop))
      .mockResolvedValue(speechCaptureResult());
    requestVoiceSummary.mockResolvedValueOnce({
      sessionId: "s1",
      messageId: "toolu_1",
      success: true,
      summary: "需要运行项目测试。",
    });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    act(() => {
      useChatStore.getState().addApprovalRequest("s1", {
        requestId: "toolu_1",
        toolName: "Bash",
        input: { command: "pnpm test" },
        status: "pending",
      });
    });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("approval"),
    );
    ttsSocket().emitJson({ type: "finished", requestId: "approval-prompt" });
    await waitFor(() => expect(createSpeechCapture).toHaveBeenCalledTimes(2));

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "拒绝" });

    await waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: "tool_deny",
        sessionId: "s1",
        payload: { toolId: "toolu_1" },
      }),
    );
    await waitFor(() => expect(approvalStop).toHaveBeenCalledTimes(1));
    act(() => {
      useChatStore.getState().updateApprovalStatus("s1", "toolu_1", "denied");
      useSessionStore.getState().updateSessionState("s1", "idle");
    });
    await flushMicrotasks();

    expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("waiting");
    expect(createSpeechCapture).toHaveBeenCalledTimes(2);

    act(() => {
      useChatStore.getState().markTurnComplete("s1");
    });
    await waitFor(() => {
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening");
      expect(createSpeechCapture).toHaveBeenCalledTimes(3);
    });
  });

  it("always-approves pending tools with the voice command after the prompt finishes", async () => {
    requestVoiceSummary.mockResolvedValueOnce({
      sessionId: "s1",
      messageId: "toolu_1",
      success: true,
      summary: "需要写入测试文件。",
    });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "toolu_1",
      toolName: "Write",
      input: { file_path: "/tmp/a", content: "a" },
      status: "pending",
    });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("approval"),
    );
    ttsSocket().emitJson({ type: "finished", requestId: "approval-prompt" });
    await waitFor(() => expect(createSpeechCapture).toHaveBeenCalledTimes(2));

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "始终允许" });

    await waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: "tool_approve",
        sessionId: "s1",
        payload: { toolId: "toolu_1", whitelistTool: true },
      }),
    );
  });

  it("keeps approval pending and explains the valid responses after unrelated speech", async () => {
    requestVoiceSummary.mockResolvedValueOnce({
      sessionId: "s1",
      messageId: "toolu_1",
      success: true,
      summary: "需要运行项目测试。",
    });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "toolu_1",
      toolName: "Bash",
      input: { command: "pnpm test" },
      status: "pending",
    });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("approval"),
    );
    ttsSocket().emitJson({ type: "finished", requestId: "approval-prompt" });
    await waitFor(() => expect(createSpeechCapture).toHaveBeenCalledTimes(2));

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "我还没想好" });

    await waitFor(() => {
      const spoken = ttsSocket()
        .sent.filter((item): item is string => typeof item === "string")
        .map((item) => JSON.parse(item));
      expect(spoken).toContainEqual(
        expect.objectContaining({
          type: "speak",
          text: "当前正在等待审批，请说允许、始终允许或拒绝。",
        }),
      );
    });
    expect(sendEnvelope).not.toHaveBeenCalled();
    expect(sendControl).not.toHaveBeenCalled();
    expect(useChatStore.getState().bySessionId.s1?.pendingApprovals[0]).toMatchObject({
      requestId: "toolu_1",
      status: "pending",
    });
  });

  it("stays waiting when an externally resolved approval clears while the agent is busy", async () => {
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    const thirdStop = vi.fn();
    createSpeechCapture
      .mockResolvedValueOnce(speechCaptureResult(firstStop))
      .mockResolvedValueOnce(speechCaptureResult(secondStop))
      .mockResolvedValueOnce(speechCaptureResult(thirdStop));
    requestVoiceSummary.mockResolvedValueOnce({
      sessionId: "s1",
      messageId: "toolu_1",
      success: true,
      summary: "需要读取构建配置。",
    });
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    act(() => {
      useChatStore.getState().addApprovalRequest("s1", {
        requestId: "toolu_1",
        toolName: "Read",
        input: { file_path: "/tmp/package.json" },
        status: "pending",
      });
    });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        phase: "approval",
        approvalRequestId: "toolu_1",
      }),
    );
    ttsSocket().emitJson({ type: "finished", requestId: "approval-prompt" });
    await waitFor(() => expect(createSpeechCapture).toHaveBeenCalledTimes(2));

    act(() => {
      useSessionStore.getState().updateSessionState("s1", "working");
      useChatStore.getState().updateApprovalStatus("s1", "toolu_1", "approved");
    });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        phase: "waiting",
        approvalRequestId: null,
      }),
    );
    await waitFor(() => expect(secondStop).toHaveBeenCalledTimes(1));
    expect(createSpeechCapture).toHaveBeenCalledTimes(2);

    act(() => {
      useSessionStore.getState().updateSessionState("s1", "idle");
    });

    await waitFor(() => {
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening");
      expect(createSpeechCapture).toHaveBeenCalledTimes(3);
    });
  });

  it("upserts a user partial bubble while ASR partial text streams", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={10000} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "partial", text: "你好" });
    await waitFor(() => {
      const messages = useChatStore.getState().bySessionId.s1?.messages ?? [];
      const partial = messages.find((m) => m.isPartial && m.role === "user");
      expect(partial?.text).toBe("你好");
    });

    asrSocket().emitJson({ type: "partial", text: "你好世界" });
    await waitFor(() => {
      const messages = useChatStore.getState().bySessionId.s1?.messages ?? [];
      const partial = messages.find((m) => m.isPartial && m.role === "user");
      expect(partial).toMatchObject({ text: "你好世界", inputMethod: "voice" });
    });
    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it("commits the partial bubble in place when the turn submits", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={50} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "partial", text: "请检查" });
    await flushMicrotasks();
    const partialBefore = useChatStore
      .getState()
      .bySessionId.s1?.messages.find((m) => m.isPartial && m.role === "user");
    expect(partialBefore).toBeDefined();
    const partialId = partialBefore!.id;

    asrSocket().emitJson({ type: "final", text: "请检查项目状态" });
    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));

    expect(sendEnvelope.mock.calls[0][0]).toMatchObject({
      type: "user_input",
      payload: { text: "请检查项目状态", messageId: partialId },
    });
    const commit = useChatStore.getState().bySessionId.s1?.messages.find((m) => m.id === partialId);
    expect(commit).toMatchObject({
      role: "user",
      isPartial: false,
      inputMethod: "voice",
      text: "请检查项目状态",
    });
    const partialAfter =
      useChatStore
        .getState()
        .bySessionId.s1?.messages.filter((m) => m.isPartial && m.role === "user") ?? [];
    expect(partialAfter).toHaveLength(0);
  });

  it("ignores late ASR partials after a voice turn has been submitted", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const asr = asrSocket();
    asr.open();
    ttsSocket().open();
    await waitForListeningReady();

    emitMicSpeechChunk();
    asr.emitJson({ type: "final", text: "嗯。" });
    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("waiting");

    asr.emitJson({ type: "partial", text: "我最近在忙着写一个操作系统。" });
    await Promise.resolve();

    const partials =
      useChatStore
        .getState()
        .bySessionId.s1?.messages.filter((m) => m.role === "user" && m.isPartial) ?? [];
    expect(partials).toHaveLength(0);
  });

  it("submits pause as ordinary agent text", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "暂停" });

    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(sendEnvelope.mock.calls[0]?.[0]).toMatchObject({ payload: { text: "暂停" } });
  });

  it("records repeat routing, replays the last response, and does not submit agent text", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    const tts = ttsSocket();
    tts.open();
    await waitForListeningReady();
    useVoicePilotStore.getState().setLastSpokenText("s1", "上一条回复");

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "再说一遍" });

    await waitFor(() =>
      expect(
        tts.sent
          .filter((item): item is string => typeof item === "string")
          .map((item) => JSON.parse(item))
          .some((item) => item.type === "speak" && item.text === "上一条回复"),
      ).toBe(true),
    );
    expect(sendEnvelope).not.toHaveBeenCalled();
    expect(getVoicePilotDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime",
          event: "voice-command-routed",
          details: { command: "repeat" },
        }),
      ]),
    );
  });

  it("mirrors machine phase through listening → waiting → speaking → waiting → listening", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitForListeningReady();
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening"),
    );

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "请检查项目状态" });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("waiting"),
    );

    const beforeReplySequence = getVoicePilotDiagnostics().at(-1)?.sequence ?? 0;
    act(() => {
      useChatStore.getState().appendAssistantText("s1", "好的。");
      useChatStore.getState().markTurnComplete("s1");
    });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("speaking"),
    );
    const replyTransitions = getVoicePilotDiagnostics()
      .filter(
        (event) =>
          event.sequence > beforeReplySequence &&
          event.scope === "state-machine" &&
          event.event === "transition",
      )
      .map((event) => event.details?.input);
    expect(replyTransitions).toContain("assistantTextReady");
    expect(replyTransitions).not.toContain("agentBecameIdle");

    ttsSocket().emitJson({ type: "finished" });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("waiting"),
    );

    act(() => {
      useSessionStore.getState().updateSessionState("s1", "idle");
    });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening"),
    );
  });
});
