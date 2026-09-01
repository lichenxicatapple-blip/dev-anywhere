import { describe, expect, it } from "vitest";
import {
  DEVICE_PREVIEW_FRAME_MAX_BYTES,
  decodeDevicePreviewFrame,
  decodeDevicePreviewHttpFrameHeader,
  encodeDevicePreviewFrame,
  encodeDevicePreviewHttpFrame,
} from "../device-preview-frame.js";

const jpeg = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

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
