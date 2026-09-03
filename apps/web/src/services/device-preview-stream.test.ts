import { describe, expect, it, vi } from "vitest";
import {
  encodeDevicePreviewH264HttpPacket,
  encodeDevicePreviewHttpFrame,
} from "@dev-anywhere/shared";
import { clearRelayClientToken, persistRelayClientToken } from "@/lib/relay-client-token";
import {
  consumeDevicePreviewH264Stream,
  consumeDevicePreviewStream,
  DevicePreviewHttpFrameParser,
  DevicePreviewHttpH264PacketParser,
} from "./device-preview-stream";

function split(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.byteLength) chunks.push(bytes.slice(offset));
  return chunks;
}

describe("DevicePreviewHttpFrameParser", () => {
  it("parses multiple records across arbitrary fetch chunk boundaries", () => {
    const first = encodeDevicePreviewHttpFrame(7, Uint8Array.from([0xff, 0xd8, 1, 0xff, 0xd9]));
    const second = encodeDevicePreviewHttpFrame(8, Uint8Array.from([0xff, 0xd8, 2, 0xff, 0xd9]));
    const bytes = new Uint8Array(first.byteLength + second.byteLength);
    bytes.set(first);
    bytes.set(second, first.byteLength);

    const parser = new DevicePreviewHttpFrameParser();
    const frames = split(bytes, [1, 2, 4, 3, 7]).flatMap((chunk) => parser.push(chunk));
    parser.finish();

    expect(frames.map((frame) => frame.sequence)).toEqual([7, 8]);
    expect([...frames[0]!.jpeg]).toEqual([0xff, 0xd8, 1, 0xff, 0xd9]);
    expect([...frames[1]!.jpeg]).toEqual([0xff, 0xd8, 2, 0xff, 0xd9]);
  });

  it("rejects zero-sized records and truncated streams", () => {
    const invalid = new Uint8Array(8);
    expect(() => new DevicePreviewHttpFrameParser().push(invalid)).toThrow(
      "Invalid device preview frame length",
    );

    const parser = new DevicePreviewHttpFrameParser();
    parser.push(
      encodeDevicePreviewHttpFrame(1, Uint8Array.from([0xff, 0xd8, 1, 0xff, 0xd9])).slice(0, -1),
    );
    expect(() => parser.finish()).toThrow("truncated frame");
  });
});

describe("DevicePreviewHttpH264PacketParser", () => {
  it("preserves every ordered H.264 packet across arbitrary fetch chunks", () => {
    const configuration = encodeDevicePreviewH264HttpPacket({
      packetSequence: 4,
      configuration: true,
      keyframe: false,
      durationMs: 0,
      annexB: Uint8Array.of(0, 0, 0, 1, 0x67),
    });
    const keyframe = encodeDevicePreviewH264HttpPacket({
      packetSequence: 5,
      configuration: false,
      keyframe: true,
      durationMs: 33,
      annexB: Uint8Array.of(0, 0, 0, 1, 0x65),
    });
    const bytes = new Uint8Array(configuration.length + keyframe.length);
    bytes.set(configuration);
    bytes.set(keyframe, configuration.length);

    const parser = new DevicePreviewHttpH264PacketParser();
    const packets = split(bytes, [1, 3, 2, 11, 4]).flatMap((chunk) => parser.push(chunk));
    parser.finish();

    expect(packets).toMatchObject([
      { sequence: 4, kind: "configuration", keyframe: false, durationMs: 0 },
      { sequence: 5, kind: "frame", keyframe: true, durationMs: 33 },
    ]);
  });
});

describe("consumeDevicePreviewStream", () => {
  it("drops superseded frames from the same network chunk", async () => {
    clearRelayClientToken();
    const first = encodeDevicePreviewHttpFrame(1, Uint8Array.from([0xff, 0xd8, 1, 0xff, 0xd9]));
    const second = encodeDevicePreviewHttpFrame(2, Uint8Array.from([0xff, 0xd8, 2, 0xff, 0xd9]));
    const body = new Uint8Array(first.byteLength + second.byteLength);
    body.set(first);
    body.set(second, first.byteLength);
    const onFrame = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
        { headers: { "X-Device-Preview-Format": "jpeg" } },
      ),
    );

    await consumeDevicePreviewStream("/api/device-preview-streams/token", {
      signal: new AbortController().signal,
      onFrame,
      fetch: fetchImpl,
    });

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ sequence: 2 }));
  });

  it("authenticates the private stream with the stored Relay client token", async () => {
    persistRelayClientToken("private-client-token");
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        { headers: { "X-Device-Preview-Format": "jpeg" } },
      ),
    );

    await consumeDevicePreviewStream("/api/device-preview-streams/one-use-token", {
      signal: new AbortController().signal,
      onFrame: vi.fn(),
      fetch: fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/device-preview-streams/one-use-token",
      expect.objectContaining({ headers: { Authorization: "Bearer private-client-token" } }),
    );
    clearRelayClientToken();
  });

  it("never sends the Relay client token to a cross-origin stream URL", async () => {
    persistRelayClientToken("private-client-token");
    const fetchImpl = vi.fn();

    await expect(
      consumeDevicePreviewStream("https://attacker.example/device-stream", {
        signal: new AbortController().signal,
        onFrame: vi.fn(),
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("不受信任");

    expect(fetchImpl).not.toHaveBeenCalled();
    clearRelayClientToken();
  });

  it.each([
    ["missing", undefined],
    ["wrong", "h264_annex_b"],
  ])("rejects a %s JPEG response format", async (_case, format) => {
    clearRelayClientToken();
    const headers = format ? { "X-Device-Preview-Format": format } : undefined;
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({ start: (controller) => controller.close() }), {
        headers,
      }),
    );

    await expect(
      consumeDevicePreviewStream("/api/device-preview-streams/jpeg-token", {
        signal: new AbortController().signal,
        onFrame: vi.fn(),
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("错误的模拟器画面格式");
  });
});

describe("consumeDevicePreviewH264Stream", () => {
  it("requires the H.264 response format and forwards all packets with screen dimensions", async () => {
    clearRelayClientToken();
    const records = [
      encodeDevicePreviewH264HttpPacket({
        packetSequence: 0,
        configuration: true,
        keyframe: false,
        durationMs: 0,
        annexB: Uint8Array.of(0, 0, 0, 1, 0x67),
      }),
      encodeDevicePreviewH264HttpPacket({
        packetSequence: 1,
        configuration: false,
        keyframe: true,
        durationMs: 33,
        annexB: Uint8Array.of(0, 0, 0, 1, 0x65),
      }),
    ];
    const body = new Uint8Array(records[0]!.length + records[1]!.length);
    body.set(records[0]!);
    body.set(records[1]!, records[0]!.length);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
        {
          headers: {
            "X-Device-Preview-Format": "h264_annex_b",
            "X-Device-Width": "324",
            "X-Device-Height": "720",
          },
        },
      ),
    );
    const onPacket = vi.fn();
    const onSize = vi.fn();

    await consumeDevicePreviewH264Stream("/api/device-preview-streams/h264-token", {
      signal: new AbortController().signal,
      onPacket,
      onSize,
      fetch: fetchImpl,
    });

    expect(onPacket.mock.calls.map(([packet]) => packet.kind)).toEqual(["configuration", "frame"]);
    expect(onSize).toHaveBeenCalledWith({ width: 324, height: 720 });
  });

  it("rejects a JPEG response instead of falling back", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({ start: (controller) => controller.close() }), {
        headers: { "X-Device-Preview-Format": "jpeg" },
      }),
    );

    await expect(
      consumeDevicePreviewH264Stream("/api/device-preview-streams/h264-token", {
        signal: new AbortController().signal,
        onPacket: vi.fn(),
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("没有返回 H.264");
  });
});
