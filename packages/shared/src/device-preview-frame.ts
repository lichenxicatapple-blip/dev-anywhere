// Dedicated Proxy stream WebSocket frame:
//   [1B streamId byte length][streamId UTF-8][4B frame sequence uint32LE][JPEG bytes]
//
// Device frames intentionally do not share the main PTY WebSocket. Keeping a separate codec makes
// it impossible for Relay/Web to accidentally treat image bytes as terminal output.

const STREAM_ID_LENGTH_BYTES = 1;
const FRAME_SEQUENCE_BYTES = 4;
const STREAM_FRAME_FIXED_HEADER_BYTES = STREAM_ID_LENGTH_BYTES + FRAME_SEQUENCE_BYTES;
export const DEVICE_PREVIEW_FRAME_MAX_BYTES = 2 * 1024 * 1024;

export interface DecodedDevicePreviewFrame {
  streamId: string;
  frameSequence: number;
  jpeg: Uint8Array;
}

export interface DecodedDevicePreviewHttpFrameHeader {
  jpegLength: number;
  frameSequence: number;
}

function isJpeg(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[data.length - 2] === 0xff &&
    data[data.length - 1] === 0xd9
  );
}

function assertJpeg(jpeg: Uint8Array): void {
  if (jpeg.length === 0 || jpeg.length > DEVICE_PREVIEW_FRAME_MAX_BYTES) {
    throw new RangeError(
      `device preview JPEG must be 1-${DEVICE_PREVIEW_FRAME_MAX_BYTES} bytes, got ${jpeg.length}`,
    );
  }
  if (!isJpeg(jpeg)) throw new TypeError("device preview frame is not a complete JPEG image");
}

export function encodeDevicePreviewFrame(
  streamId: string,
  frameSequence: number,
  jpeg: Uint8Array,
): Uint8Array {
  const streamIdBytes = new TextEncoder().encode(streamId);
  if (streamIdBytes.length === 0 || streamIdBytes.length > 255) {
    throw new RangeError(`streamId byte length must be 1-255, got ${streamIdBytes.length}`);
  }
  if (!Number.isInteger(frameSequence) || frameSequence < 0 || frameSequence > 0xffffffff) {
    throw new RangeError(`frameSequence must be a uint32, got ${frameSequence}`);
  }
  assertJpeg(jpeg);

  const frame = new Uint8Array(
    STREAM_ID_LENGTH_BYTES + streamIdBytes.length + FRAME_SEQUENCE_BYTES + jpeg.length,
  );
  frame[0] = streamIdBytes.length;
  frame.set(streamIdBytes, STREAM_ID_LENGTH_BYTES);
  const sequenceOffset = STREAM_ID_LENGTH_BYTES + streamIdBytes.length;
  new DataView(frame.buffer, frame.byteOffset + sequenceOffset, FRAME_SEQUENCE_BYTES).setUint32(
    0,
    frameSequence,
    true,
  );
  frame.set(jpeg, sequenceOffset + FRAME_SEQUENCE_BYTES);
  return frame;
}

export function decodeDevicePreviewFrame(view: Uint8Array): DecodedDevicePreviewFrame | null {
  if (view.length < STREAM_FRAME_FIXED_HEADER_BYTES + 1) return null;
  const streamIdLength = view[0];
  if (streamIdLength === 0) return null;
  const sequenceOffset = STREAM_ID_LENGTH_BYTES + streamIdLength;
  const payloadOffset = sequenceOffset + FRAME_SEQUENCE_BYTES;
  if (
    view.length <= payloadOffset ||
    view.length - payloadOffset > DEVICE_PREVIEW_FRAME_MAX_BYTES
  ) {
    return null;
  }
  const jpeg = view.subarray(payloadOffset);
  if (!isJpeg(jpeg)) return null;
  let streamId: string;
  try {
    streamId = new TextDecoder("utf-8", { fatal: true }).decode(
      view.subarray(STREAM_ID_LENGTH_BYTES, STREAM_ID_LENGTH_BYTES + streamIdLength),
    );
  } catch {
    return null;
  }
  const frameSequence = new DataView(
    view.buffer,
    view.byteOffset + sequenceOffset,
    FRAME_SEQUENCE_BYTES,
  ).getUint32(0, true);
  return { streamId, frameSequence, jpeg };
}

// Relay HTTP response record:
//   [4B JPEG length uint32LE][4B frame sequence uint32LE][JPEG bytes]
// The browser parser accepts arbitrary HTTP chunk boundaries and can drop superseded records.
export const DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES = 8;

export function encodeDevicePreviewHttpFrame(frameSequence: number, jpeg: Uint8Array): Uint8Array {
  if (!Number.isInteger(frameSequence) || frameSequence < 0 || frameSequence > 0xffffffff) {
    throw new RangeError(`frameSequence must be a uint32, got ${frameSequence}`);
  }
  assertJpeg(jpeg);
  const record = new Uint8Array(DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES + jpeg.length);
  const header = new DataView(
    record.buffer,
    record.byteOffset,
    DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES,
  );
  header.setUint32(0, jpeg.length, true);
  header.setUint32(4, frameSequence, true);
  record.set(jpeg, DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES);
  return record;
}

export function decodeDevicePreviewHttpFrameHeader(
  view: Uint8Array,
): DecodedDevicePreviewHttpFrameHeader | null {
  if (view.length < DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES) return null;
  const header = new DataView(view.buffer, view.byteOffset, DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES);
  const jpegLength = header.getUint32(0, true);
  if (jpegLength === 0 || jpegLength > DEVICE_PREVIEW_FRAME_MAX_BYTES) return null;
  return { jpegLength, frameSequence: header.getUint32(4, true) };
}
