import { describe, expect, it, vi } from "vitest";
import { encodeDevicePreviewHttpFrame } from "@dev-anywhere/shared";
import { clearRelayClientToken, persistRelayClientToken } from "@/lib/relay-client-token";
import { consumeDevicePreviewStream, DevicePreviewHttpFrameParser } from "./device-preview-stream";

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
});
