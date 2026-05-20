import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createPcmCapture,
  sendEnvelope,
  sendControl,
  requestVoiceConfig,
  requestVoiceSummary,
  wakeEnable,
  wakeDisable,
  playerEnqueue,
  playerStop,
  setPlayerActivityHandler,
  emitPlayerActivity,
} = vi.hoisted(() => {
  const activity = { handler: null as ((level: number) => void) | null };
  return {
    createPcmCapture: vi.fn(),
    sendEnvelope: vi.fn(),
    sendControl: vi.fn(),
    requestVoiceConfig: vi.fn(),
    requestVoiceSummary: vi.fn(),
    wakeEnable: vi.fn(),
    wakeDisable: vi.fn(),
    playerEnqueue: vi.fn(),
    playerStop: vi.fn(),
    setPlayerActivityHandler: (next: ((level: number) => void) | null) => {
      activity.handler = next;
    },
    emitPlayerActivity: (level: number) => {
      activity.handler?.(level);
    },
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

vi.mock("@/voice/pcm-capture", () => ({
  createPcmCapture,
}));

vi.mock("@/voice/pcm-stream-player", () => ({
  PcmStreamPlayer: class {
    constructor(
      _context: AudioContext,
      _sampleRate?: number,
      options?: { onActivityLevel?: (level: number) => void },
    ) {
      setPlayerActivityHandler(options?.onActivityLevel ?? null);
    }

    enqueue = playerEnqueue;
    stop = playerStop;
  },
}));

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sent.push(data);
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
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
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

function emitMicSpeechChunk(callIndex = createPcmCapture.mock.calls.length - 1): void {
  const onChunk = createPcmCapture.mock.calls[callIndex]?.[0] as
    | ((chunk: Uint8Array) => void)
    | undefined;
  if (!onChunk) throw new Error("PCM capture callback was not created");
  onChunk(new Uint8Array([0xff, 0x7f, 0xff, 0x7f, 0x00, 0x40, 0x00, 0x40]));
}

import { VoicePilotController } from "./voice-pilot-controller";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { useVoicePilotStore } from "@/voice/voice-pilot-store";

describe("VoicePilotController", () => {
  beforeEach(() => {
    cleanup();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal(
      "AudioContext",
      class {
        currentTime = 0;
      },
    );
    createPcmCapture.mockReset();
    createPcmCapture.mockResolvedValue({ stop: vi.fn() });
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
    playerStop.mockReset();
    setPlayerActivityHandler(null);
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
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    expect(wakeEnable).toHaveBeenCalledTimes(1);
    expect(asrSocket().url).toContain("/voice/asr");
    expect(ttsSocket().url).toContain("/voice/tts");
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
    expect(JSON.parse(asrSocket().sent[0] as string)).toMatchObject({
      type: "start",
      sessionId: "s1",
      sampleRate: 16000,
    });
    expect(createPcmCapture).toHaveBeenCalledTimes(1);
  });

  it("drives the Voice Pilot activity meter from microphone and speech PCM", async () => {
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

    const onMicChunk = createPcmCapture.mock.calls[0][0] as (chunk: Uint8Array) => void;
    onMicChunk(new Uint8Array([0xff, 0x7f, 0x00, 0x40]));
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

  it("stops microphone capture when the ASR provider reports an error", async () => {
    const stopCapture = vi.fn();
    createPcmCapture.mockResolvedValueOnce({ stop: stopCapture });
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

    asrSocket().emitJson({ type: "error", error: "ASR disconnected" });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        phase: "error",
        error: "ASR disconnected",
      }),
    );
    expect(stopCapture).toHaveBeenCalledTimes(1);
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
    createPcmCapture
      .mockResolvedValueOnce({ stop: firstStop })
      .mockResolvedValueOnce({ stop: secondStop });
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const asr = asrSocket();
    const tts = ttsSocket();
    asr.open();
    tts.open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
    emitMicSpeechChunk();
    asr.emitJson({ type: "final", text: "第一轮" });

    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(firstStop).toHaveBeenCalledTimes(1);

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

    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(2));
    const asrStartMessages = asr.sent.filter(
      (item) => typeof item === "string" && JSON.parse(item).type === "start",
    );
    expect(asrStartMessages).toHaveLength(2);

    const onSecondMicChunk = createPcmCapture.mock.calls[1][0] as (chunk: Uint8Array) => void;
    onSecondMicChunk(new Uint8Array([0xff, 0x7f, 0x00, 0x40]));
    expect(asr.sent.some((item) => item instanceof Uint8Array)).toBe(true);
  });

  it("does not resume microphone capture while the agent session is still working", async () => {
    createPcmCapture
      .mockResolvedValueOnce({ stop: vi.fn() })
      .mockResolvedValueOnce({ stop: vi.fn() });
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const asr = asrSocket();
    const tts = ttsSocket();
    asr.open();
    tts.open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
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
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(createPcmCapture).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionStore.getState().updateSessionState("s1", "idle");
    });
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(2));
  });

  it("waits when agent status is thinking even if the session state has not flipped yet", async () => {
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    createPcmCapture
      .mockResolvedValueOnce({ stop: firstStop })
      .mockResolvedValueOnce({ stop: secondStop });
    useVoicePilotStore.getState().enable("s1");

    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
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
    expect(createPcmCapture).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionStore.getState().setAgentStatus("s1", {
        provider: "claude",
        phase: "idle",
        seq: 2,
        updatedAt: 110,
      });
    });

    await waitFor(() => {
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening");
      expect(createPcmCapture).toHaveBeenCalledTimes(2);
    });
  });

  it("sends final ASR text as JSON input without touching the typed draft", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
    emitMicSpeechChunk();
    asr.emitJson({ type: "final", text: "嗯。" });

    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it("ignores ASR text when the microphone has not detected user speech", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

    asrSocket().emitJson({ type: "partial", text: "嗯。" });
    asrSocket().emitJson({ type: "final", text: "嗯。" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendEnvelope).not.toHaveBeenCalled();
    expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening");
    const userMessages =
      useChatStore.getState().bySessionId.s1?.messages.filter((m) => m.role === "user") ?? [];
    expect(userMessages).toHaveLength(0);
  });

  it("plays a local earcon before sending recognized speech to the agent", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "执行下一步" });

    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(playerEnqueue).toHaveBeenCalled();
    expect(playerEnqueue.mock.invocationCallOrder[0]).toBeLessThan(
      sendEnvelope.mock.invocationCallOrder[0],
    );
  });

  it("speaks completed assistant prose through TTS", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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

  it("waits for queued TTS playback before resuming microphone capture", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    const tts = ttsSocket();
    tts.open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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

    expect(createPcmCapture).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(2));
  });

  it("surfaces active TTS provider errors instead of remaining in speaking", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(useVoicePilotStore.getState().bySessionId.s1?.phase).not.toBe("error");
    expect(useVoicePilotStore.getState().bySessionId.s1?.error).toBeNull();
    expect(createPcmCapture).not.toHaveBeenCalled();

    asrSocket().open();

    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
      expect(createPcmCapture).toHaveBeenCalledTimes(2);
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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(2));

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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(2));

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

  it("stays waiting when an externally resolved approval clears while the agent is busy", async () => {
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    const thirdStop = vi.fn();
    createPcmCapture
      .mockResolvedValueOnce({ stop: firstStop })
      .mockResolvedValueOnce({ stop: secondStop })
      .mockResolvedValueOnce({ stop: thirdStop });
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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(2));

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
    expect(secondStop).toHaveBeenCalled();
    expect(createPcmCapture).toHaveBeenCalledTimes(2);

    act(() => {
      useSessionStore.getState().updateSessionState("s1", "idle");
    });

    await waitFor(() => {
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening");
      expect(createPcmCapture).toHaveBeenCalledTimes(3);
    });
  });

  it("upserts a user partial bubble while ASR partial text streams", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={10000} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
      expect(partial?.text).toBe("你好世界");
    });
    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it("commits the partial bubble in place when the turn submits", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={50} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "partial", text: "请检查" });
    const messages = useChatStore.getState().bySessionId.s1?.messages ?? [];
    expect(messages.some((m) => m.isPartial && m.role === "user")).toBe(true);
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
    expect(commit).toMatchObject({ role: "user", isPartial: false, text: "请检查项目状态" });
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
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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

  it("discards the partial bubble when the recognized turn is a voice command", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "暂停" });

    await waitFor(() => expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("paused"));
    const remaining =
      useChatStore.getState().bySessionId.s1?.messages.filter((m) => m.role === "user") ?? [];
    expect(remaining).toHaveLength(0);
    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it("mirrors machine phase through listening → waiting → speaking → waiting → listening", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening"),
    );

    emitMicSpeechChunk();
    asrSocket().emitJson({ type: "final", text: "请检查项目状态" });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("waiting"),
    );

    useChatStore.getState().appendAssistantText("s1", "好的。");
    useChatStore.getState().markTurnComplete("s1");

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("speaking"),
    );

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
