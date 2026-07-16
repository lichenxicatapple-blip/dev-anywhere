import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceAsrTransport } from "./voice-asr-transport";

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  emit(payload: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }
}

function controlMessages(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .filter((message): message is string => typeof message === "string")
    .map((message) => JSON.parse(message) as Record<string, unknown>);
}

async function startReadyAttempt(
  transport: VoiceAsrTransport,
  socket: FakeWebSocket,
  attemptId = "attempt-1",
) {
  const pending = transport.startAttempt({
    sessionId: "session-1",
    attemptId,
    sampleRate: 16000,
    encoding: "mulaw",
  });
  socket.open();
  await vi.waitFor(() => expect(controlMessages(socket)).toHaveLength(1));
  expect(controlMessages(socket)[0]).toEqual({
    type: "start",
    sessionId: "session-1",
    attemptId,
    sampleRate: 16000,
    encoding: "mulaw",
  });
  socket.emit({ type: "ready", attemptId });
  return pending;
}

describe("VoiceAsrTransport", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards provider text for the active attempt", async () => {
    const socket = new FakeWebSocket();
    const onPartial = vi.fn();
    const onFinal = vi.fn();
    const transport = new VoiceAsrTransport({
      url: "ws://relay.test/voice/asr",
      createSocket: () => socket as unknown as WebSocket,
      onPartial,
      onFinal,
      onAttemptError: vi.fn(),
      onTransportError: vi.fn(),
    });
    await startReadyAttempt(transport, socket);

    socket.emit({ type: "partial", attemptId: "attempt-1", text: "你好" });
    socket.emit({ type: "final", attemptId: "attempt-1", text: "你好世界" });

    expect(onPartial).toHaveBeenCalledWith("你好", "attempt-1");
    expect(onFinal).toHaveBeenCalledWith("你好世界", "attempt-1");
  });

  it("uses Relay acknowledgements to bound in-flight audio and preserves stop ordering", async () => {
    const socket = new FakeWebSocket();
    const transport = new VoiceAsrTransport({
      url: "ws://relay.test/voice/asr",
      createSocket: () => socket as unknown as WebSocket,
      inFlightWindowBytes: 4,
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onAttemptError: vi.fn(),
      onTransportError: vi.fn(),
    });
    const attempt = await startReadyAttempt(transport, socket);

    attempt.send(Uint8Array.from([1, 2, 3]));
    attempt.send(Uint8Array.from([4, 5, 6]));
    attempt.send(Uint8Array.from([7, 8]));
    attempt.finish();
    expect(socket.sent.filter((message) => message instanceof Uint8Array)).toHaveLength(1);
    expect(controlMessages(socket).map((message) => message.type)).toEqual(["start"]);

    socket.emit({
      type: "audio_ack",
      attemptId: "attempt-1",
      encodedBytes: 3,
      pcmBytes: 6,
      chunks: 1,
    });
    expect(socket.sent.filter((message) => message instanceof Uint8Array)).toHaveLength(2);
    expect(controlMessages(socket).map((message) => message.type)).toEqual(["start"]);

    socket.emit({
      type: "audio_ack",
      attemptId: "attempt-1",
      encodedBytes: 6,
      pcmBytes: 12,
      chunks: 2,
    });
    expect(socket.sent.filter((message) => message instanceof Uint8Array)).toHaveLength(3);
    expect(controlMessages(socket).map((message) => message.type)).toEqual(["start", "stop"]);
    expect(attempt.snapshot()).toMatchObject({
      queuedBytes: 0,
      sentBytes: 8,
      acknowledgedBytes: 6,
      finishRequested: true,
      stopSent: true,
    });
  });

  it("completes a finished attempt when the provider closes it", async () => {
    const socket = new FakeWebSocket();
    const onAttemptComplete = vi.fn();
    const transport = new VoiceAsrTransport({
      url: "ws://relay.test/voice/asr",
      createSocket: () => socket as unknown as WebSocket,
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onAttemptComplete,
      onAttemptError: vi.fn(),
      onTransportError: vi.fn(),
    });
    const attempt = await startReadyAttempt(transport, socket);

    attempt.finish();
    socket.emit({
      type: "closed",
      attemptId: "attempt-1",
      code: 1000,
      reason: "completed",
    });

    expect(onAttemptComplete).toHaveBeenCalledOnce();
    expect(onAttemptComplete).toHaveBeenCalledWith("attempt-1", "closed");
  });

  it("completes a finished attempt when the provider never closes it", async () => {
    const socket = new FakeWebSocket();
    const onAttemptComplete = vi.fn();
    const transport = new VoiceAsrTransport({
      url: "ws://relay.test/voice/asr",
      createSocket: () => socket as unknown as WebSocket,
      completionTimeoutMs: 500,
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onAttemptComplete,
      onAttemptError: vi.fn(),
      onTransportError: vi.fn(),
    });
    const attempt = await startReadyAttempt(transport, socket);

    vi.useFakeTimers();
    try {
      attempt.finish();
      await vi.advanceTimersByTimeAsync(500);

      expect(onAttemptComplete).toHaveBeenCalledOnce();
      expect(onAttemptComplete).toHaveBeenCalledWith("attempt-1", "timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an active socket failure once through the attempt boundary", async () => {
    const socket = new FakeWebSocket();
    const onAttemptError = vi.fn();
    const onTransportError = vi.fn();
    const transport = new VoiceAsrTransport({
      url: "ws://relay.test/voice/asr",
      createSocket: () => socket as unknown as WebSocket,
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onAttemptError,
      onTransportError,
    });
    await startReadyAttempt(transport, socket);

    socket.close();

    expect(onAttemptError).toHaveBeenCalledOnce();
    expect(onAttemptError).toHaveBeenCalledWith("语音识别连接已断开", "attempt-1");
    expect(onTransportError).not.toHaveBeenCalled();
  });

  it("returns a provider startup failure without also firing the active-attempt callback", async () => {
    const socket = new FakeWebSocket();
    const onAttemptError = vi.fn();
    const transport = new VoiceAsrTransport({
      url: "ws://relay.test/voice/asr",
      createSocket: () => socket as unknown as WebSocket,
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onAttemptError,
      onTransportError: vi.fn(),
    });
    const pending = transport.startAttempt({
      sessionId: "session-1",
      attemptId: "attempt-1",
      sampleRate: 16000,
      encoding: "mulaw",
    });
    socket.open();
    await vi.waitFor(() => expect(controlMessages(socket)).toHaveLength(1));

    socket.emit({ type: "error", attemptId: "attempt-1", error: "provider unavailable" });

    await expect(pending).rejects.toThrow("provider unavailable");
    expect(onAttemptError).not.toHaveBeenCalled();
  });
});
