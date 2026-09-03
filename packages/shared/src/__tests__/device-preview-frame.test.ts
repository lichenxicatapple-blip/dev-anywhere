import { describe, expect, it } from "vitest";
import {
  DEVICE_PREVIEW_FRAME_MAX_BYTES,
  DEVICE_PREVIEW_H264_FLAG_CONFIGURATION,
  DEVICE_PREVIEW_H264_FLAG_KEYFRAME,
  DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES,
  DEVICE_PREVIEW_H264_PACKET_SENTINEL,
  DEVICE_PREVIEW_H264_PACKET_VERSION,
  decodeDevicePreviewFrame,
  decodeDevicePreviewH264HttpPacketHeader,
  decodeDevicePreviewH264ProxyPacket,
  decodeDevicePreviewHttpFrameHeader,
  encodeDevicePreviewFrame,
  encodeDevicePreviewH264HttpPacket,
  encodeDevicePreviewH264ProxyPacket,
  encodeDevicePreviewHttpFrame,
} from "../device-preview-frame.js";

const jpeg = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const annexB = Uint8Array.from([0, 0, 0, 1, 0x65, 1, 2, 3]);

describe("device preview frame codec", () => {
  it("round-trips a Proxy stream frame", () => {
    const encoded = encodeDevicePreviewFrame("stream-一", 42, jpeg);
    const decoded = decodeDevicePreviewFrame(encoded);
    expect(decoded?.streamId).toBe("stream-一");
    expect(decoded?.frameSequence).toBe(42);
    expect(decoded?.jpeg).toEqual(jpeg);
  });

  it("rejects malformed identifiers, truncated headers and non-JPEG payloads", () => {
    expect(decodeDevicePreviewFrame(Uint8Array.of())).toBeNull();
    expect(decodeDevicePreviewFrame(Uint8Array.of(4, 1, 2, 3))).toBeNull();
    expect(() => encodeDevicePreviewFrame("stream-1", 0, Uint8Array.of(1, 2, 3))).toThrow(/JPEG/);

    const encoded = encodeDevicePreviewFrame("stream-1", 0, jpeg);
    encoded[1] = 0xff;
    expect(decodeDevicePreviewFrame(encoded)).toBeNull();
  });

  it("bounds identifiers, sequences and payload size", () => {
    expect(() => encodeDevicePreviewFrame("", 0, jpeg)).toThrow(RangeError);
    expect(() => encodeDevicePreviewFrame("x".repeat(256), 0, jpeg)).toThrow(RangeError);
    expect(() => encodeDevicePreviewFrame("stream-1", -1, jpeg)).toThrow(RangeError);
    const oversized = new Uint8Array(DEVICE_PREVIEW_FRAME_MAX_BYTES + 1);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    oversized[oversized.length - 2] = 0xff;
    oversized[oversized.length - 1] = 0xd9;
    expect(() => encodeDevicePreviewFrame("stream-1", 0, oversized)).toThrow(RangeError);
  });

  it("encodes the HTTP record header in little endian", () => {
    const record = encodeDevicePreviewHttpFrame(0x12345678, jpeg);
    expect(decodeDevicePreviewHttpFrameHeader(record)).toEqual({
      jpegLength: jpeg.length,
      frameSequence: 0x12345678,
    });
    expect(record.subarray(8)).toEqual(jpeg);
    expect(decodeDevicePreviewHttpFrameHeader(record.subarray(0, 7))).toBeNull();
  });
});

describe("device preview H.264 packet codec", () => {
  it("round-trips a versioned Proxy packet without colliding with the JPEG envelope", () => {
    const encoded = encodeDevicePreviewH264ProxyPacket("stream-一", {
      packetSequence: 0x12345678,
      configuration: true,
      keyframe: false,
      durationMs: 33,
      annexB,
    });

    expect(encoded[0]).toBe(DEVICE_PREVIEW_H264_PACKET_SENTINEL);
    expect(encoded[1]).toBe(DEVICE_PREVIEW_H264_PACKET_VERSION);
    expect(encoded[2]).toBe(DEVICE_PREVIEW_H264_FLAG_CONFIGURATION);
    const sequenceOffset = 4 + new TextEncoder().encode("stream-一").length;
    expect(Array.from(encoded.subarray(sequenceOffset, sequenceOffset + 6))).toEqual([
      0x78, 0x56, 0x34, 0x12, 33, 0,
    ]);
    expect(decodeDevicePreviewFrame(encoded)).toBeNull();
    expect(decodeDevicePreviewH264ProxyPacket(encoded)).toEqual({
      streamId: "stream-一",
      packetSequence: 0x12345678,
      configuration: true,
      keyframe: false,
      durationMs: 33,
      annexB,
    });
  });

  it("rejects packets that ambiguously mark configuration as a keyframe", () => {
    const invalidPacket = {
      packetSequence: 1,
      configuration: true,
      keyframe: true,
      durationMs: 0,
      annexB,
    };
    expect(() => encodeDevicePreviewH264ProxyPacket("stream-1", invalidPacket)).toThrow(
      /mutually exclusive/,
    );
    expect(() => encodeDevicePreviewH264HttpPacket(invalidPacket)).toThrow(/mutually exclusive/);

    const bothFlags = DEVICE_PREVIEW_H264_FLAG_CONFIGURATION | DEVICE_PREVIEW_H264_FLAG_KEYFRAME;
    const proxyPacket = encodeDevicePreviewH264ProxyPacket("stream-1", {
      ...invalidPacket,
      configuration: false,
    });
    proxyPacket[2] = bothFlags;
    expect(decodeDevicePreviewH264ProxyPacket(proxyPacket)).toBeNull();

    const httpPacket = encodeDevicePreviewH264HttpPacket({
      ...invalidPacket,
      configuration: false,
    });
    httpPacket[2] = bothFlags;
    expect(decodeDevicePreviewH264HttpPacketHeader(httpPacket)).toBeNull();
  });

  it("encodes a length-prefixed HTTP record with equivalent metadata", () => {
    const encoded = encodeDevicePreviewH264HttpPacket({
      packetSequence: 9,
      configuration: false,
      keyframe: true,
      durationMs: 40,
      annexB,
    });

    expect(encoded.byteLength).toBe(DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES + annexB.length);
    expect(Array.from(encoded.subarray(3, DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES))).toEqual([
      annexB.length,
      0,
      0,
      0,
      9,
      0,
      0,
      0,
      40,
      0,
    ]);
    expect(decodeDevicePreviewH264HttpPacketHeader(encoded)).toEqual({
      annexBLength: annexB.length,
      packetSequence: 9,
      configuration: false,
      keyframe: true,
      durationMs: 40,
    });
    expect(encoded.subarray(DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES)).toEqual(annexB);
  });

  it("rejects unknown flags, versions, malformed UTF-8 and non-Annex-B payloads", () => {
    const encoded = encodeDevicePreviewH264ProxyPacket("stream-1", {
      packetSequence: 1,
      configuration: false,
      keyframe: false,
      durationMs: 16,
      annexB,
    });

    const unknownVersion = encoded.slice();
    unknownVersion[1] = 2;
    expect(decodeDevicePreviewH264ProxyPacket(unknownVersion)).toBeNull();

    const unknownFlags = encoded.slice();
    unknownFlags[2] = 0x80;
    expect(decodeDevicePreviewH264ProxyPacket(unknownFlags)).toBeNull();

    const malformedId = encoded.slice();
    malformedId[4] = 0xff;
    expect(decodeDevicePreviewH264ProxyPacket(malformedId)).toBeNull();

    const malformedPayload = encoded.slice();
    malformedPayload[malformedPayload.length - annexB.length] = 1;
    expect(decodeDevicePreviewH264ProxyPacket(malformedPayload)).toBeNull();

    expect(decodeDevicePreviewH264ProxyPacket(Uint8Array.of(0, 1, 0))).toBeNull();

    const httpPacket = encodeDevicePreviewH264HttpPacket({
      packetSequence: 1,
      configuration: false,
      keyframe: false,
      durationMs: 16,
      annexB,
    });
    expect(
      decodeDevicePreviewH264HttpPacketHeader(
        httpPacket.subarray(0, DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES - 1),
      ),
    ).toBeNull();
    const unknownHttpFlags = httpPacket.slice();
    unknownHttpFlags[2] = 0x80;
    expect(decodeDevicePreviewH264HttpPacketHeader(unknownHttpFlags)).toBeNull();
    const oversizedHttpPayload = httpPacket.slice();
    new DataView(oversizedHttpPayload.buffer).setUint32(
      3,
      DEVICE_PREVIEW_FRAME_MAX_BYTES + 1,
      true,
    );
    expect(decodeDevicePreviewH264HttpPacketHeader(oversizedHttpPayload)).toBeNull();
  });

  it("bounds identifiers, sequence, duration and Annex-B payload size", () => {
    const packet = {
      packetSequence: 0,
      configuration: false,
      keyframe: false,
      durationMs: 0,
      annexB,
    };
    expect(() => encodeDevicePreviewH264ProxyPacket("", packet)).toThrow(RangeError);
    expect(() => encodeDevicePreviewH264ProxyPacket("x".repeat(256), packet)).toThrow(RangeError);
    expect(() =>
      encodeDevicePreviewH264HttpPacket({ ...packet, packetSequence: 0x1_0000_0000 }),
    ).toThrow(RangeError);
    expect(() => encodeDevicePreviewH264HttpPacket({ ...packet, durationMs: 0x1_0000 })).toThrow(
      RangeError,
    );
    expect(() =>
      encodeDevicePreviewH264HttpPacket({ ...packet, annexB: Uint8Array.of(1, 2, 3) }),
    ).toThrow(/Annex-B/);

    const oversized = new Uint8Array(DEVICE_PREVIEW_FRAME_MAX_BYTES + 1);
    oversized.set([0, 0, 1, 0x65]);
    expect(() => encodeDevicePreviewH264HttpPacket({ ...packet, annexB: oversized })).toThrow(
      RangeError,
    );
  });
});
