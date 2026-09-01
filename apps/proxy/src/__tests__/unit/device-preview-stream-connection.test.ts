import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeDevicePreviewFrame } from "@dev-anywhere/shared";
import { DevicePreviewStreamConnection } from "#src/serve/device-preview/device-preview-stream-connection.js";

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Array<{ data: unknown; options?: unknown }> = [];
  readonly close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit("close", 1000, Buffer.alloc(0)));
  });
  readonly terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit("close", 1006, Buffer.alloc(0)));
  });

  readonly send = vi.fn(
    (data: unknown, options?: unknown, callback?: (error?: Error) => void): void => {
      this.sent.push({ data, options });
      callback?.();
    },
  );

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  message(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)), false);
  }
}

describe("DevicePreviewStreamConnection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("authenticates the dedicated socket before flushing binary device frames", async () => {
    const sockets: FakeWebSocket[] = [];
    const createWebSocket = vi.fn(() => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const onFlow = vi.fn();
    const connection = new DevicePreviewStreamConnection({
      relayUrl: "wss://relay.example/ws/",
      proxyId: "proxy-1",
      token: "secret token",
      onFlow,
      createWebSocket,
    });

    connection.register("connection-1");
    expect(createWebSocket).toHaveBeenCalledWith(
      "wss://relay.example/ws/proxy-stream?token=secret%20token",
      expect.objectContaining({ perMessageDeflate: false }),
    );
    const socket = sockets[0]!;
    socket.open();
    expect(JSON.parse(String(socket.sent[0]?.data))).toEqual({
      type: "device_preview_stream_register",
      proxyId: "proxy-1",
      connectionId: "connection-1",
    });

    const pending = connection.sendFrame("stream-1", 7, Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]));
    expect(socket.sent).toHaveLength(1);
    socket.message({ type: "device_preview_stream_register_response", success: true });
    await expect(pending).resolves.toBeUndefined();

    const binary = socket.sent[1]?.data;
    expect(Buffer.isBuffer(binary)).toBe(true);
    expect(decodeDevicePreviewFrame(Buffer.from(binary as Buffer))).toMatchObject({
      streamId: "stream-1",
      frameSequence: 7,
    });
    socket.message({ type: "device_preview_stream_flow", streamId: "stream-1", paused: true });
    expect(onFlow).toHaveBeenCalledWith("stream-1", true);
    connection.close();
  });

  it("rotates to the newest main-connection nonce and never reuses the old socket", () => {
    const sockets: FakeWebSocket[] = [];
    const connection = new DevicePreviewStreamConnection({
      relayUrl: "ws://127.0.0.1:3000",
      proxyId: "proxy-1",
      onFlow: vi.fn(),
      createWebSocket: vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      }),
    });

    connection.register("connection-old");
    const old = sockets[0]!;
    old.open();
    connection.register("connection-new");

    expect(old.terminate).toHaveBeenCalledOnce();
    const replacement = sockets[1]!;
    replacement.open();
    expect(JSON.parse(String(replacement.sent[0]?.data))).toMatchObject({
      connectionId: "connection-new",
    });
    connection.close();
  });

  it("reconnects with bounded backoff while the main connection nonce remains current", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const createWebSocket = vi.fn(() => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const connection = new DevicePreviewStreamConnection({
      relayUrl: "ws://127.0.0.1:3000",
      proxyId: "proxy-1",
      onFlow: vi.fn(),
      createWebSocket,
      random: () => 0.5,
    });
    connection.register("connection-1");
    sockets[0]!.open();
    sockets[0]!.emit("close", 1006, Buffer.alloc(0));

    await vi.advanceTimersByTimeAsync(249);
    expect(createWebSocket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(createWebSocket).toHaveBeenCalledTimes(2);
    connection.close();
  });

  it("rejects queued frames and stops reconnecting after the main connection is lost", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const createWebSocket = vi.fn(() => socket as unknown as WebSocket);
    const connection = new DevicePreviewStreamConnection({
      relayUrl: "ws://127.0.0.1:3000",
      proxyId: "proxy-1",
      onFlow: vi.fn(),
      createWebSocket,
    });
    connection.register("connection-1");
    socket.open();
    const pending = connection.sendFrame("stream-1", 0, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    connection.disconnectMain();

    await expect(pending).rejects.toThrow("已断开");
    expect(socket.terminate).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(createWebSocket).toHaveBeenCalledOnce();
  });
});
