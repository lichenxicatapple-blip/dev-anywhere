import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Response } from "express";
import { createLogger } from "@dev-anywhere/shared/logger";
import {
  decodeDevicePreviewH264HttpPacketHeader,
  type DevicePreviewH264Packet,
  type DevicePreviewStreamFormat,
} from "@dev-anywhere/shared";
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
  firstFrameTimer: ReturnType<typeof setTimeout> | null;
  headersSent: boolean;
  finished: boolean;
  paused: boolean;
  requestedFormat: DevicePreviewStreamFormat;
  format?: DevicePreviewStreamFormat;
  h264SyncState: "awaiting_configuration" | "awaiting_keyframe" | "synced";
  h264DroppedWhilePaused: boolean;
  lastFrameSequence: number | null;
  bufferedStartingFrame?: { sequence: number; jpeg: Uint8Array };
  bufferedStartingH264?: {
    configuration: DevicePreviewH264Packet;
    packets: DevicePreviewH264Packet[];
    totalBytes: number;
    hasKeyframe: boolean;
  };
  drainListener?: () => void;
  drainTimer?: ReturnType<typeof setTimeout>;
}

interface DevicePreviewBridgeInternals {
  streams: Map<string, TestStream>;
  leases: Map<string, unknown>;
  handleFrame(transport: TestTransport, streamId: string, sequence: number, jpeg: Uint8Array): void;
  handleH264Packet(
    transport: TestTransport,
    streamId: string,
    packet: DevicePreviewH264Packet,
  ): void;
  armFirstFrameTimer(stream: TestStream): void;
  handleStreamStartResponse(
    proxyId: string,
    message: {
      type: "device_preview_stream_start_response";
      streamId: string;
      leaseId: string;
      previewId: string;
      success: true;
      format: DevicePreviewStreamFormat;
    },
  ): void;
  writeH264Packet(stream: TestStream, packet: DevicePreviewH264Packet): void;
  markStreamFinished(stream: TestStream): void;
}

function h264Packet(
  packetSequence: number,
  kind: "configuration" | "keyframe" | "delta",
): DevicePreviewH264Packet {
  return {
    packetSequence,
    configuration: kind === "configuration",
    keyframe: kind === "keyframe",
    durationMs: kind === "configuration" ? 0 : 33,
    annexB: Uint8Array.of(
      0,
      0,
      1,
      kind === "configuration" ? 0x67 : kind === "keyframe" ? 0x65 : 0x41,
    ),
  };
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
      firstFrameTimer: null,
      headersSent: true,
      finished: false,
      paused: false,
      requestedFormat: "jpeg",
      h264SyncState: "awaiting_configuration",
      h264DroppedWhilePaused: false,
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
      resyncRequired: false,
    });

    internals.handleFrame(transport, stream.streamId, 2, jpeg);
    expect(response.write).toHaveBeenCalledTimes(1);

    response.emit("drain");
    expect(JSON.parse(String(send.mock.calls[1]?.[0]))).toEqual({
      type: "device_preview_stream_flow",
      streamId: stream.streamId,
      paused: false,
      resyncRequired: false,
    });
    internals.handleFrame(transport, stream.streamId, 3, jpeg);
    expect(response.write).toHaveBeenCalledTimes(2);

    clearTimeout(stream.startTimer);
    if (stream.firstFrameTimer) clearTimeout(stream.firstFrameTimer);
    internals.streams.clear();
    bridge.dispose();
  });

  it("ends only the blocked stream and its lease when HTTP drain never arrives", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new DevicePreviewBridge({
        registry: new RelayRegistry(),
        logger,
        drainTimeoutMs: 50,
      });
      const proxyWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;
      const transport: TestTransport = {
        ws: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket,
        proxyId: "p1",
        connectionId: "connection-1",
      };
      const response = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      response.write = vi.fn().mockReturnValue(false);
      response.destroy = vi.fn();
      const lease = {
        leaseId: "lease-blocked",
        clientId: "client-1",
        clientWs: { readyState: WebSocket.CLOSED } as unknown as WebSocket,
        proxyId: "p1",
        bindingId: "binding-1",
        proxyWs,
        previewId: "preview-1",
        controller: false,
        streamId: "stream-blocked",
        lastInputSeq: -1,
        rateWindowStartedAt: 0,
        inputCount: 0,
        outstandingInputSeqs: new Set<number>(),
      };
      const stream: TestStream = {
        streamId: "stream-blocked",
        lease,
        transport,
        res: response as unknown as Response,
        state: "streaming",
        startTimer: setTimeout(() => undefined, 60_000),
        firstFrameTimer: null,
        headersSent: true,
        finished: false,
        paused: false,
        requestedFormat: "jpeg",
        format: "jpeg",
        h264SyncState: "awaiting_configuration",
        h264DroppedWhilePaused: false,
        lastFrameSequence: null,
      };
      const internals = bridge as unknown as DevicePreviewBridgeInternals;
      const healthyLease = {
        ...lease,
        leaseId: "lease-healthy",
        streamId: "stream-healthy",
      };
      const healthyStream: TestStream = {
        ...stream,
        streamId: "stream-healthy",
        lease: healthyLease,
        res: new EventEmitter() as unknown as Response,
        startTimer: setTimeout(() => undefined, 60_000),
      };
      internals.streams.set(stream.streamId, stream);
      internals.leases.set(lease.leaseId, lease);
      internals.streams.set(healthyStream.streamId, healthyStream);
      internals.leases.set(healthyLease.leaseId, healthyLease);

      internals.handleFrame(
        transport,
        stream.streamId,
        1,
        Uint8Array.from([0xff, 0xd8, 0x01, 0xff, 0xd9]),
      );
      expect(stream.paused).toBe(true);

      await vi.advanceTimersByTimeAsync(49);
      expect(internals.streams.has(stream.streamId)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      expect(internals.streams.has(stream.streamId)).toBe(false);
      expect(internals.leases.has(lease.leaseId)).toBe(false);
      expect(internals.streams.get(healthyStream.streamId)).toBe(healthyStream);
      expect(internals.leases.get(healthyLease.leaseId)).toBe(healthyLease);
      expect(response.destroy).toHaveBeenCalledWith(new Error("设备画面发送超时"));
      expect(
        vi
          .mocked(proxyWs.send)
          .mock.calls.map(([raw]) => JSON.parse(String(raw)))
          .some(
            (message) =>
              message.type === "device_preview_stream_stop" &&
              message.streamId === stream.streamId &&
              message.reason === "stream_error",
          ),
      ).toBe(true);
      internals.markStreamFinished(healthyStream);
      internals.leases.delete(healthyLease.leaseId);
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
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
      firstFrameTimer: null,
      headersSent: false,
      finished: false,
      paused: false,
      requestedFormat: "jpeg",
      h264SyncState: "awaiting_configuration",
      h264DroppedWhilePaused: false,
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

  it("filters the requested wire format before advancing the shared packet sequence", () => {
    const bridge = new DevicePreviewBridge({ registry: new RelayRegistry(), logger });
    const transport: TestTransport = {
      ws: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket,
      proxyId: "p1",
      connectionId: "connection-1",
    };
    const jpeg = Uint8Array.of(0xff, 0xd8, 1, 0xff, 0xd9);
    const makeStream = (
      streamId: string,
      requestedFormat: DevicePreviewStreamFormat,
    ): TestStream => ({
      streamId,
      lease: { proxyId: "p1" },
      transport,
      res: new EventEmitter() as unknown as Response,
      state: "starting",
      startTimer: setTimeout(() => undefined, 60_000),
      firstFrameTimer: null,
      headersSent: false,
      finished: false,
      paused: false,
      requestedFormat,
      h264SyncState: "awaiting_configuration",
      h264DroppedWhilePaused: false,
      lastFrameSequence: null,
    });
    const h264Stream = makeStream("stream-h264-filter", "h264_annex_b");
    const jpegStream = makeStream("stream-jpeg-filter", "jpeg");
    h264Stream.startTimer.unref?.();
    jpegStream.startTimer.unref?.();
    const internals = bridge as unknown as DevicePreviewBridgeInternals;
    internals.streams.set(h264Stream.streamId, h264Stream);
    internals.streams.set(jpegStream.streamId, jpegStream);

    internals.handleFrame(transport, h264Stream.streamId, 100, jpeg);
    internals.handleH264Packet(transport, h264Stream.streamId, h264Packet(1, "configuration"));
    expect(h264Stream.lastFrameSequence).toBe(1);
    expect(h264Stream.bufferedStartingH264?.configuration.packetSequence).toBe(1);

    internals.handleH264Packet(transport, jpegStream.streamId, h264Packet(100, "configuration"));
    internals.handleFrame(transport, jpegStream.streamId, 1, jpeg);
    expect(jpegStream.lastFrameSequence).toBe(1);
    expect(jpegStream.bufferedStartingFrame?.sequence).toBe(1);

    clearTimeout(h264Stream.startTimer);
    clearTimeout(jpegStream.startTimer);
    internals.streams.clear();
    bridge.dispose();
  });

  it("caps tiny H.264 startup packets with incremental byte and keyframe state", () => {
    const bridge = new DevicePreviewBridge({ registry: new RelayRegistry(), logger });
    const transport: TestTransport = {
      ws: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket,
      proxyId: "p1",
      connectionId: "connection-1",
    };
    const stream: TestStream = {
      streamId: "stream-h264-buffer-cap",
      lease: { proxyId: "p1" },
      transport,
      res: new EventEmitter() as unknown as Response,
      state: "starting",
      startTimer: setTimeout(() => undefined, 60_000),
      firstFrameTimer: null,
      headersSent: false,
      finished: false,
      paused: false,
      requestedFormat: "h264_annex_b",
      h264SyncState: "awaiting_configuration",
      h264DroppedWhilePaused: false,
      lastFrameSequence: null,
    };
    stream.startTimer.unref?.();
    const internals = bridge as unknown as DevicePreviewBridgeInternals;
    internals.streams.set(stream.streamId, stream);

    internals.handleH264Packet(transport, stream.streamId, h264Packet(0, "configuration"));
    internals.handleH264Packet(transport, stream.streamId, h264Packet(1, "keyframe"));
    for (let sequence = 2; sequence <= 511; sequence += 1) {
      internals.handleH264Packet(transport, stream.streamId, h264Packet(sequence, "delta"));
    }
    expect(stream.bufferedStartingH264).toMatchObject({
      totalBytes: 512 * 4,
      hasKeyframe: true,
    });
    expect(stream.bufferedStartingH264?.packets).toHaveLength(512);

    internals.handleH264Packet(transport, stream.streamId, h264Packet(512, "delta"));
    expect(stream.bufferedStartingH264).toMatchObject({ totalBytes: 4, hasKeyframe: false });
    expect(stream.bufferedStartingH264?.packets).toHaveLength(1);
    expect(transport.ws.send).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(transport.ws.send).mock.calls.map(([raw]) => {
        const message = JSON.parse(String(raw)) as {
          paused: boolean;
          resyncRequired: boolean;
        };
        return [message.paused, message.resyncRequired];
      }),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
    internals.handleH264Packet(transport, stream.streamId, h264Packet(513, "delta"));
    expect(stream.bufferedStartingH264?.packets).toHaveLength(1);

    const maxPayload = (kind: "configuration" | "keyframe"): DevicePreviewH264Packet => {
      const packet = h264Packet(kind === "configuration" ? 600 : 601, kind);
      packet.annexB = new Uint8Array(2 * 1024 * 1024);
      packet.annexB.set([0, 0, 1, kind === "configuration" ? 0x67 : 0x65]);
      return packet;
    };
    internals.handleH264Packet(transport, stream.streamId, maxPayload("configuration"));
    internals.handleH264Packet(transport, stream.streamId, maxPayload("keyframe"));
    expect(stream.bufferedStartingH264).toMatchObject({
      totalBytes: 4 * 1024 * 1024,
      hasKeyframe: true,
    });
    internals.handleH264Packet(transport, stream.streamId, h264Packet(602, "delta"));
    expect(stream.bufferedStartingH264).toMatchObject({
      totalBytes: 2 * 1024 * 1024,
      hasKeyframe: false,
    });
    expect(stream.bufferedStartingH264?.packets).toHaveLength(1);
    expect(transport.ws.send).toHaveBeenCalledTimes(4);
    expect(
      vi
        .mocked(transport.ws.send)
        .mock.calls.slice(2)
        .map(([raw]) => {
          const message = JSON.parse(String(raw)) as {
            paused: boolean;
            resyncRequired: boolean;
          };
          return [message.paused, message.resyncRequired];
        }),
    ).toEqual([
      [true, false],
      [false, true],
    ]);

    internals.markStreamFinished(stream);
    expect(stream.bufferedStartingH264).toBeUndefined();
    bridge.dispose();
  });

  it("requires configuration then keyframe only when H.264 packets were dropped while paused", () => {
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
      streamId: "stream-h264-backpressure",
      lease: { proxyId: "p1" },
      transport,
      res: response as unknown as Response,
      state: "streaming",
      startTimer: setTimeout(() => undefined, 60_000),
      firstFrameTimer: null,
      headersSent: true,
      finished: false,
      paused: false,
      requestedFormat: "h264_annex_b",
      format: "h264_annex_b",
      h264SyncState: "synced",
      h264DroppedWhilePaused: false,
      lastFrameSequence: null,
    };
    stream.startTimer.unref?.();
    const internals = bridge as unknown as DevicePreviewBridgeInternals;
    internals.streams.set(stream.streamId, stream);

    internals.handleH264Packet(transport, stream.streamId, h264Packet(1, "delta"));
    expect(stream.paused).toBe(true);
    expect(stream.h264SyncState).toBe("synced");
    internals.handleH264Packet(transport, stream.streamId, h264Packet(2, "delta"));
    expect(response.write).toHaveBeenCalledTimes(1);
    expect(stream.h264DroppedWhilePaused).toBe(true);

    response.emit("drain");
    expect(stream.paused).toBe(false);
    expect(stream.h264SyncState).toBe("awaiting_configuration");
    internals.handleH264Packet(transport, stream.streamId, h264Packet(3, "delta"));
    internals.handleH264Packet(transport, stream.streamId, h264Packet(4, "keyframe"));
    internals.handleH264Packet(transport, stream.streamId, h264Packet(5, "configuration"));
    internals.handleH264Packet(transport, stream.streamId, h264Packet(6, "delta"));
    internals.handleH264Packet(transport, stream.streamId, h264Packet(7, "keyframe"));
    internals.handleH264Packet(transport, stream.streamId, h264Packet(8, "delta"));

    expect(
      response.write.mock.calls.map(
        ([record]) => decodeDevicePreviewH264HttpPacketHeader(record as Uint8Array)?.packetSequence,
      ),
    ).toEqual([1, 5, 7, 8]);
    expect(stream.h264SyncState).toBe("synced");
    expect(
      send.mock.calls.map(([message]) => {
        const flow = JSON.parse(String(message)) as {
          paused: boolean;
          resyncRequired: boolean;
        };
        return [flow.paused, flow.resyncRequired];
      }),
    ).toEqual([
      [true, false],
      [false, true],
    ]);

    clearTimeout(stream.startTimer);
    internals.streams.clear();
    bridge.dispose();
  });

  it("does not self-resynchronize when every accepted large H.264 keyframe crosses the HTTP high-water mark", () => {
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
    const httpHighWaterMark = 64 * 1024;
    response.write = vi.fn((record: Uint8Array) => record.byteLength < httpHighWaterMark);
    const stream: TestStream = {
      streamId: "stream-h264-large-keyframes",
      lease: { proxyId: "p1" },
      transport,
      res: response as unknown as Response,
      state: "streaming",
      startTimer: setTimeout(() => undefined, 60_000),
      firstFrameTimer: null,
      headersSent: true,
      finished: false,
      paused: false,
      requestedFormat: "h264_annex_b",
      format: "h264_annex_b",
      h264SyncState: "synced",
      h264DroppedWhilePaused: false,
      lastFrameSequence: null,
    };
    stream.startTimer.unref?.();
    const internals = bridge as unknown as DevicePreviewBridgeInternals;
    internals.streams.set(stream.streamId, stream);

    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const keyframe = h264Packet(sequence, "keyframe");
      keyframe.annexB = new Uint8Array(httpHighWaterMark);
      keyframe.annexB.set([0, 0, 1, 0x65]);
      internals.handleH264Packet(transport, stream.streamId, keyframe);

      expect(stream.paused).toBe(true);
      expect(stream.h264SyncState).toBe("synced");
      response.emit("drain");
      expect(stream.paused).toBe(false);
      expect(stream.h264SyncState).toBe("synced");
    }

    expect(response.write).toHaveBeenCalledTimes(3);
    expect(
      send.mock.calls.map(([message]) => {
        const flow = JSON.parse(String(message)) as {
          paused: boolean;
          resyncRequired: boolean;
        };
        return [flow.paused, flow.resyncRequired];
      }),
    ).toEqual([
      [true, false],
      [false, false],
      [true, false],
      [false, false],
      [true, false],
      [false, false],
    ]);

    clearTimeout(stream.startTimer);
    internals.streams.clear();
    bridge.dispose();
  });

  it("clears the H.264 first-frame deadline only after configuration then keyframe", () => {
    const bridge = new DevicePreviewBridge({
      registry: new RelayRegistry(),
      logger,
      firstFrameTimeoutMs: 60_000,
    });
    const response = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
    };
    response.write = vi.fn().mockReturnValue(true);
    const stream: TestStream = {
      streamId: "stream-h264-starting",
      lease: { proxyId: "p1" },
      transport: {
        ws: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket,
        proxyId: "p1",
        connectionId: "connection-1",
      },
      res: response as unknown as Response,
      state: "streaming",
      startTimer: setTimeout(() => undefined, 60_000),
      firstFrameTimer: null,
      headersSent: true,
      finished: false,
      paused: false,
      requestedFormat: "h264_annex_b",
      format: "h264_annex_b",
      h264SyncState: "awaiting_configuration",
      h264DroppedWhilePaused: false,
      lastFrameSequence: null,
    };
    const internals = bridge as unknown as DevicePreviewBridgeInternals;
    internals.streams.set(stream.streamId, stream);
    internals.armFirstFrameTimer(stream);

    internals.writeH264Packet(stream, h264Packet(0, "delta"));
    internals.writeH264Packet(stream, h264Packet(1, "keyframe"));
    expect(response.write).not.toHaveBeenCalled();
    expect(stream.firstFrameTimer).not.toBeNull();

    internals.writeH264Packet(stream, h264Packet(2, "configuration"));
    expect(stream.firstFrameTimer).not.toBeNull();
    expect(stream.h264SyncState).toBe("awaiting_keyframe");

    internals.writeH264Packet(stream, h264Packet(3, "delta"));
    expect(response.write).toHaveBeenCalledTimes(1);
    expect(stream.firstFrameTimer).not.toBeNull();

    internals.writeH264Packet(stream, h264Packet(4, "keyframe"));
    expect(response.write).toHaveBeenCalledTimes(2);
    expect(stream.h264SyncState).toBe("synced");
    expect(stream.firstFrameTimer).toBeNull();

    clearTimeout(stream.startTimer);
    internals.streams.clear();
    bridge.dispose();
  });

  it("treats a quiet JPEG stream as healthy after its first frame", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new DevicePreviewBridge({
        registry: new RelayRegistry(),
        logger,
        firstFrameTimeoutMs: 50,
      });
      const response = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
      };
      response.write = vi.fn().mockReturnValue(true);
      const transport: TestTransport = {
        ws: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket,
        proxyId: "p1",
        connectionId: "connection-1",
      };
      const stream: TestStream = {
        streamId: "stream-jpeg-static",
        lease: { proxyId: "p1" },
        transport,
        res: response as unknown as Response,
        state: "streaming",
        startTimer: setTimeout(() => undefined, 60_000),
        firstFrameTimer: null,
        headersSent: true,
        finished: false,
        paused: false,
        requestedFormat: "jpeg",
        format: "jpeg",
        h264SyncState: "awaiting_configuration",
        h264DroppedWhilePaused: false,
        lastFrameSequence: null,
      };
      const internals = bridge as unknown as DevicePreviewBridgeInternals;
      internals.streams.set(stream.streamId, stream);
      internals.armFirstFrameTimer(stream);

      internals.handleFrame(
        transport,
        stream.streamId,
        0,
        Uint8Array.of(0xff, 0xd8, 1, 0xff, 0xd9),
      );
      expect(response.write).toHaveBeenCalledOnce();
      expect(stream.firstFrameTimer).toBeNull();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(internals.streams.get(stream.streamId)).toBe(stream);
      expect(stream.finished).toBe(false);

      clearTimeout(stream.startTimer);
      internals.streams.clear();
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a started JPEG stream that never produces its first frame", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new DevicePreviewBridge({
        registry: new RelayRegistry(),
        logger,
        firstFrameTimeoutMs: 50,
      });
      const proxyWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;
      const response = new EventEmitter() as EventEmitter & {
        status: ReturnType<typeof vi.fn>;
        setHeader: ReturnType<typeof vi.fn>;
        flushHeaders: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      response.status = vi.fn();
      response.setHeader = vi.fn();
      response.flushHeaders = vi.fn();
      response.destroy = vi.fn();
      const lease = {
        leaseId: "lease-no-first-frame",
        clientId: "client-1",
        clientWs: { readyState: WebSocket.CLOSED } as unknown as WebSocket,
        proxyId: "p1",
        bindingId: "binding-1",
        proxyWs,
        previewId: "preview-1",
        controller: false,
        streamId: "stream-no-first-frame",
        lastInputSeq: -1,
        rateWindowStartedAt: 0,
        inputCount: 0,
        outstandingInputSeqs: new Set<number>(),
      };
      const stream: TestStream = {
        streamId: "stream-no-first-frame",
        lease,
        transport: {
          ws: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket,
          proxyId: "p1",
          connectionId: "connection-1",
        },
        res: response as unknown as Response,
        state: "starting",
        startTimer: setTimeout(() => undefined, 60_000),
        firstFrameTimer: null,
        headersSent: false,
        finished: false,
        paused: false,
        requestedFormat: "jpeg",
        h264SyncState: "awaiting_configuration",
        h264DroppedWhilePaused: false,
        lastFrameSequence: null,
      };
      const internals = bridge as unknown as DevicePreviewBridgeInternals;
      internals.streams.set(stream.streamId, stream);
      internals.leases.set(lease.leaseId, lease);

      internals.handleStreamStartResponse("p1", {
        type: "device_preview_stream_start_response",
        streamId: stream.streamId,
        leaseId: lease.leaseId,
        previewId: lease.previewId,
        success: true,
        format: "jpeg",
      });
      expect(stream.firstFrameTimer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(49);
      expect(internals.streams.get(stream.streamId)).toBe(stream);
      await vi.advanceTimersByTimeAsync(1);

      expect(internals.streams.has(stream.streamId)).toBe(false);
      expect(internals.leases.has(lease.leaseId)).toBe(false);
      expect(response.destroy).toHaveBeenCalledWith(new Error("等待设备画面首帧超时"));
      expect(
        vi
          .mocked(proxyWs.send)
          .mock.calls.map(([raw]) => JSON.parse(String(raw)))
          .some(
            (message) =>
              message.type === "device_preview_stream_stop" &&
              message.streamId === stream.streamId &&
              message.reason === "stream_error",
          ),
      ).toBe(true);
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a backpressured JPEG as the first frame and clears its startup deadline", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new DevicePreviewBridge({
        registry: new RelayRegistry(),
        logger,
        firstFrameTimeoutMs: 50,
        drainTimeoutMs: 60_000,
      });
      const response = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
      };
      response.write = vi.fn().mockReturnValue(false);
      const transport: TestTransport = {
        ws: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket,
        proxyId: "p1",
        connectionId: "connection-1",
      };
      const stream: TestStream = {
        streamId: "stream-jpeg-first-frame-backpressure",
        lease: { proxyId: "p1" },
        transport,
        res: response as unknown as Response,
        state: "streaming",
        startTimer: setTimeout(() => undefined, 60_000),
        firstFrameTimer: null,
        headersSent: true,
        finished: false,
        paused: false,
        requestedFormat: "jpeg",
        format: "jpeg",
        h264SyncState: "awaiting_configuration",
        h264DroppedWhilePaused: false,
        lastFrameSequence: null,
      };
      const internals = bridge as unknown as DevicePreviewBridgeInternals;
      internals.streams.set(stream.streamId, stream);
      internals.armFirstFrameTimer(stream);

      internals.handleFrame(
        transport,
        stream.streamId,
        0,
        Uint8Array.of(0xff, 0xd8, 1, 0xff, 0xd9),
      );
      expect(response.write).toHaveBeenCalledOnce();
      expect(stream.paused).toBe(true);
      expect(stream.firstFrameTimer).toBeNull();

      await vi.advanceTimersByTimeAsync(51);
      expect(internals.streams.get(stream.streamId)).toBe(stream);
      internals.markStreamFinished(stream);
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DevicePreviewBridge management failures", () => {
  it("returns a typed Proxy-offline capability failure", () => {
    const registry = new RelayRegistry();
    const proxy = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;
    registry.registerProxy("proxy-1", proxy);
    const sent: string[] = [];
    const client = {
      clientId: "client-1",
      readyState: WebSocket.OPEN,
      send: (raw: unknown) => sent.push(String(raw)),
    } as unknown as WebSocket & { clientId: string };
    const bindingId = registry.bindClientById("client-1", "proxy-1", client);
    if (!bindingId) throw new Error("missing test binding");
    Object.assign(proxy, { readyState: WebSocket.CLOSED });
    const bridge = new DevicePreviewBridge({ registry, logger });

    expect(
      bridge.handleClientControl(client, {
        type: "device_preview_capability_request",
        requestId: "capability-1",
        scope: { proxyId: "proxy-1", bindingId },
        refreshPath: false,
      }),
    ).toBe(true);
    expect(sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        type: "device_preview_capability_response",
        requestId: "capability-1",
        scope: { proxyId: "proxy-1", bindingId },
        success: false,
        error: "当前开发机不在线",
        errorCode: "PROXY_OFFLINE",
      },
    ]);

    bridge.dispose();
  });
});
