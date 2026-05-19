import { cleanup, render, waitFor } from "@testing-library/react";
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
} = vi.hoisted(() => ({
  createPcmCapture: vi.fn(),
  sendEnvelope: vi.fn(),
  sendControl: vi.fn(),
  requestVoiceConfig: vi.fn(),
  requestVoiceSummary: vi.fn(),
  wakeEnable: vi.fn(),
  wakeDisable: vi.fn(),
  playerEnqueue: vi.fn(),
  playerStop: vi.fn(),
}));

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
    useVoicePilotStore.getState().resetAll();
    useChatStore.setState({ bySessionId: { s1: { ...EMPTY_SLICE, inputDraft: "typed draft" } } });
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
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
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.activityLevel).toBeGreaterThan(0),
    );

    ttsSocket().emitJson({ type: "finished" });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.activityLevel).toBe(0),
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
    asr.emitJson({ type: "final", text: "第一轮" });

    await waitFor(() => expect(sendEnvelope).toHaveBeenCalledTimes(1));
    expect(firstStop).toHaveBeenCalledTimes(1);

    useChatStore.getState().appendAssistantText("s1", "收到。");
    useChatStore.getState().markTurnComplete("s1");
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

  it("sends final ASR text as JSON input without touching the typed draft", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
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
    asr.emitJson({ type: "final", text: "嗯。" });

    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it("plays a local earcon before sending recognized speech to the agent", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
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

  it("speaks pending approval details and waits for explicit approval phrase", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();

    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "toolu_1",
      toolName: "Bash",
      input: { command: "pnpm test" },
      status: "pending",
    });

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
            text: expect.stringContaining("批准这次"),
          }),
        ]),
      );
    });

    ttsSocket().emitJson({ type: "finished", requestId: "approval-prompt" });

    await waitFor(() => {
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        phase: "approval",
        approvalRequestId: "toolu_1",
      });
    });
  });

  it("approves pending tools only with the exact voice command", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "toolu_1",
      toolName: "Bash",
      input: { command: "pnpm test" },
      status: "pending",
    });
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("approval"),
    );

    asrSocket().emitJson({ type: "final", text: "可以" });

    await waitFor(() => expect(sendEnvelope).not.toHaveBeenCalled());
    expect(sendControl).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        ttsSocket().sent.some(
          (item) =>
            typeof item === "string" &&
            JSON.parse(item).type === "speak" &&
            JSON.parse(item).text.includes("批准这次"),
        ),
      ).toBe(true),
    );

    asrSocket().emitJson({ type: "final", text: "批准这次" });

    await waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: "tool_approve",
        sessionId: "s1",
        payload: { toolId: "toolu_1", whitelistTool: false },
      }),
    );
  });

  it("upserts a user partial bubble while ASR partial text streams", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={10000} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

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
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

    asrSocket().emitJson({ type: "partial", text: "请检查" });
    await waitFor(() => {
      const messages = useChatStore.getState().bySessionId.s1?.messages ?? [];
      expect(messages.some((m) => m.isPartial && m.role === "user")).toBe(true);
    });
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
    const commit = useChatStore
      .getState()
      .bySessionId.s1?.messages.find((m) => m.id === partialId);
    expect(commit).toMatchObject({ role: "user", isPartial: false, text: "请检查项目状态" });
    const partialAfter = useChatStore
      .getState()
      .bySessionId.s1?.messages.filter((m) => m.isPartial && m.role === "user") ?? [];
    expect(partialAfter).toHaveLength(0);
  });

  it("discards the partial bubble when the recognized turn is a voice command", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));

    asrSocket().emitJson({ type: "final", text: "暂停" });

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("paused"),
    );
    const remaining = useChatStore
      .getState()
      .bySessionId.s1?.messages.filter((m) => m.role === "user") ?? [];
    expect(remaining).toHaveLength(0);
    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it("mirrors machine phase through a full listening → waiting → speaking → listening turn", async () => {
    useVoicePilotStore.getState().enable("s1");
    render(<VoicePilotController sessionId="s1" turnIdleMs={1} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    asrSocket().open();
    ttsSocket().open();
    await waitFor(() => expect(createPcmCapture).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening"),
    );

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
      expect(useVoicePilotStore.getState().bySessionId.s1?.phase).toBe("listening"),
    );
  });
});
