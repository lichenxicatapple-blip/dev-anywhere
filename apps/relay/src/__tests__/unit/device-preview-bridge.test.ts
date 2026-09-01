import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Response } from "express";
import { createLogger } from "@dev-anywhere/shared/logger";
import { DevicePreviewBridge } from "#src/device-preview-bridge.js";
import { RelayRegistry } from "#src/registry.js";

const logger = createLogger({ name: "device-preview-bridge-test", silent: true });

interface TestTransport {
  ws: WebSocket;
  proxyId: string;
  connectionId: string;
}

interface TestStream {
  streamId: string;
  lease: { proxyId: string };
  transport: TestTransport;
  res: Response;
  state: "starting" | "streaming";
  startTimer: ReturnType<typeof setTimeout>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  headersSent: boolean;
  finished: boolean;
  paused: boolean;
  lastFrameSequence: number | null;
  bufferedStartingFrame?: { sequence: number; jpeg: Uint8Array };
  drainListener?: () => void;
}

interface DevicePreviewBridgeInternals {
  streams: Map<string, TestStream>;
  handleFrame(transport: TestTransport, streamId: string, sequence: number, jpeg: Uint8Array): void;
  markStreamFinished(stream: TestStream): void;
}

describe("DevicePreviewBridge backpressure", () => {
  it("pauses the exact Proxy stream, drops frames while blocked, then resumes on drain", () => {
    const bridge = new DevicePreviewBridge({ registry: new RelayRegistry(), logger });
    const send = vi.fn();
    const transport: TestTransport = {
      ws: { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
      proxyId: "p1",
      connectionId: "connection-1",
    };
    const response = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
    };
    response.write = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const stream: TestStream = {
      streamId: "stream-1",
      lease: { proxyId: "p1" },
      transport,
      res: response as unknown as Response,
      state: "streaming",
      startTimer: setTimeout(() => undefined, 60_000),
      idleTimer: null,
      headersSent: true,
      finished: false,
      paused: false,
      lastFrameSequence: null,
    };
    stream.startTimer.unref?.();
    const internals = bridge as unknown as DevicePreviewBridgeInternals;
    internals.streams.set(stream.streamId, stream);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);

    internals.handleFrame(transport, stream.streamId, 1, jpeg);
    expect(response.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toEqual({
      type: "device_preview_stream_flow",
      streamId: stream.streamId,
      paused: true,
    });

    internals.handleFrame(transport, stream.streamId, 2, jpeg);
    expect(response.write).toHaveBeenCalledTimes(1);

    response.emit("drain");
    expect(JSON.parse(String(send.mock.calls[1]?.[0]))).toEqual({
      type: "device_preview_stream_flow",
      streamId: stream.streamId,
      paused: false,
    });
    internals.handleFrame(transport, stream.streamId, 3, jpeg);
    expect(response.write).toHaveBeenCalledTimes(2);

    clearTimeout(stream.startTimer);
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    internals.streams.clear();
    bridge.dispose();
  });

  it("buffers only the newest frame from the exact transport while starting and clears it on finish", () => {
    const bridge = new DevicePreviewBridge({ registry: new RelayRegistry(), logger });
    const transport: TestTransport = {
      ws: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket,
      proxyId: "p1",
      connectionId: "connection-1",
    };
    const response = new EventEmitter();
    const stream: TestStream = {
      streamId: "stream-starting",
      lease: { proxyId: "p1" },
      transport,
      res: response as unknown as Response,
      state: "starting",
      startTimer: setTimeout(() => undefined, 60_000),
      idleTimer: null,
      headersSent: false,
      finished: false,
      paused: false,
      lastFrameSequence: null,
    };
    stream.startTimer.unref?.();
    const internals = bridge as unknown as DevicePreviewBridgeInternals;
    internals.streams.set(stream.streamId, stream);

    const first = Uint8Array.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    const latest = Uint8Array.from([0xff, 0xd8, 0x02, 0xff, 0xd9]);
    const wrongTransport = { ...transport };
    internals.handleFrame(wrongTransport, stream.streamId, 9, latest);
    expect(stream.bufferedStartingFrame).toBeUndefined();

    internals.handleFrame(transport, stream.streamId, 1, first);
    internals.handleFrame(transport, stream.streamId, 3, latest);
    internals.handleFrame(transport, stream.streamId, 2, first);
    expect(stream.bufferedStartingFrame?.sequence).toBe(3);
    expect(Array.from(stream.bufferedStartingFrame?.jpeg ?? [])).toEqual(Array.from(latest));
    expect(stream.bufferedStartingFrame?.jpeg).not.toBe(latest);

    internals.markStreamFinished(stream);
    expect(stream.bufferedStartingFrame).toBeUndefined();
    expect(internals.streams.has(stream.streamId)).toBe(false);
    bridge.dispose();
  });
});
