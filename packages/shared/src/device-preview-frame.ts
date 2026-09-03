// Dedicated Proxy stream WebSocket frame:
//   [1B streamId byte length][streamId UTF-8][4B frame sequence uint32LE][JPEG bytes]
//
// Device frames intentionally do not share the main PTY WebSocket. Keeping a separate codec makes
// it impossible for Relay/Web to accidentally treat image bytes as terminal output.

const STREAM_ID_LENGTH_BYTES = 1;
const FRAME_SEQUENCE_BYTES = 4;
const STREAM_FRAME_FIXED_HEADER_BYTES = STREAM_ID_LENGTH_BYTES + FRAME_SEQUENCE_BYTES;
export const DEVICE_PREVIEW_FRAME_MAX_BYTES = 2 * 1024 * 1024;

const H264_PACKET_SENTINEL_BYTES = 1;
const H264_PACKET_VERSION_BYTES = 1;
const H264_PACKET_FLAGS_BYTES = 1;
const H264_PACKET_DURATION_BYTES = 2;
const H264_PACKET_PAYLOAD_LENGTH_BYTES = 4;
const H264_PROXY_STREAM_ID_LENGTH_OFFSET =
  H264_PACKET_SENTINEL_BYTES + H264_PACKET_VERSION_BYTES + H264_PACKET_FLAGS_BYTES;
const H264_PROXY_STREAM_ID_OFFSET = H264_PROXY_STREAM_ID_LENGTH_OFFSET + STREAM_ID_LENGTH_BYTES;
const H264_HTTP_PAYLOAD_LENGTH_OFFSET =
  H264_PACKET_SENTINEL_BYTES + H264_PACKET_VERSION_BYTES + H264_PACKET_FLAGS_BYTES;
const H264_HTTP_SEQUENCE_OFFSET =
  H264_HTTP_PAYLOAD_LENGTH_OFFSET + H264_PACKET_PAYLOAD_LENGTH_BYTES;
const H264_HTTP_DURATION_OFFSET = H264_HTTP_SEQUENCE_OFFSET + FRAME_SEQUENCE_BYTES;

export const DEVICE_PREVIEW_H264_PACKET_SENTINEL = 0;
export const DEVICE_PREVIEW_H264_PACKET_VERSION = 1;
export const DEVICE_PREVIEW_H264_FLAG_CONFIGURATION = 1 << 0;
export const DEVICE_PREVIEW_H264_FLAG_KEYFRAME = 1 << 1;
const H264_PACKET_KNOWN_FLAGS =
  DEVICE_PREVIEW_H264_FLAG_CONFIGURATION | DEVICE_PREVIEW_H264_FLAG_KEYFRAME;

// Excludes the variable-length stream ID and Annex-B payload.
export const DEVICE_PREVIEW_H264_PROXY_PACKET_FIXED_HEADER_BYTES =
  H264_PROXY_STREAM_ID_OFFSET + FRAME_SEQUENCE_BYTES + H264_PACKET_DURATION_BYTES;
// HTTP records omit streamId but include payload length because fetch chunks have arbitrary bounds.
export const DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES =
  H264_HTTP_DURATION_OFFSET + H264_PACKET_DURATION_BYTES;

export interface DecodedDevicePreviewFrame {
  streamId: string;
  frameSequence: number;
  jpeg: Uint8Array;
}

export interface DecodedDevicePreviewHttpFrameHeader {
  jpegLength: number;
  frameSequence: number;
}

export interface DevicePreviewH264Packet {
  packetSequence: number;
  configuration: boolean;
  keyframe: boolean;
  durationMs: number;
  annexB: Uint8Array;
}

export interface DecodedDevicePreviewH264ProxyPacket extends DevicePreviewH264Packet {
  streamId: string;
}

export interface DecodedDevicePreviewH264HttpPacketHeader {
  annexBLength: number;
  packetSequence: number;
  configuration: boolean;
  keyframe: boolean;
  durationMs: number;
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

function isAnnexB(data: Uint8Array): boolean {
  return (
    (data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 1) ||
    (data.length >= 5 && data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1)
  );
}

function assertPacketSequence(packetSequence: number): void {
  if (!Number.isInteger(packetSequence) || packetSequence < 0 || packetSequence > 0xffffffff) {
    throw new RangeError(`packetSequence must be a uint32, got ${packetSequence}`);
  }
}

function assertPacketDuration(durationMs: number): void {
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 0xffff) {
    throw new RangeError(`durationMs must be a uint16, got ${durationMs}`);
  }
}

function assertAnnexB(annexB: Uint8Array): void {
  if (annexB.length === 0 || annexB.length > DEVICE_PREVIEW_FRAME_MAX_BYTES) {
    throw new RangeError(
      `device preview H.264 payload must be 1-${DEVICE_PREVIEW_FRAME_MAX_BYTES} bytes, got ${annexB.length}`,
    );
  }
  if (!isAnnexB(annexB)) {
    throw new TypeError("device preview H.264 payload must use Annex-B start codes");
  }
}

function h264PacketFlags(packet: Pick<DevicePreviewH264Packet, "configuration" | "keyframe">) {
  if (packet.configuration && packet.keyframe) {
    throw new TypeError(
      "device preview H.264 configuration and keyframe flags are mutually exclusive",
    );
  }
  return (
    (packet.configuration ? DEVICE_PREVIEW_H264_FLAG_CONFIGURATION : 0) |
    (packet.keyframe ? DEVICE_PREVIEW_H264_FLAG_KEYFRAME : 0)
  );
}

function decodeH264PacketFlags(
  flags: number,
): Pick<DevicePreviewH264Packet, "configuration" | "keyframe"> | null {
  if ((flags & ~H264_PACKET_KNOWN_FLAGS) !== 0) return null;
  if (
    (flags & (DEVICE_PREVIEW_H264_FLAG_CONFIGURATION | DEVICE_PREVIEW_H264_FLAG_KEYFRAME)) ===
    (DEVICE_PREVIEW_H264_FLAG_CONFIGURATION | DEVICE_PREVIEW_H264_FLAG_KEYFRAME)
  ) {
    return null;
  }
  return {
    configuration: (flags & DEVICE_PREVIEW_H264_FLAG_CONFIGURATION) !== 0,
    keyframe: (flags & DEVICE_PREVIEW_H264_FLAG_KEYFRAME) !== 0,
  };
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

// Dedicated Proxy H.264 packet:
//   [1B zero sentinel][1B version][1B flags][1B streamId byte length][streamId UTF-8]
//   [4B packet sequence uint32LE][2B durationMs uint16LE][H.264 Annex-B bytes]
//
// JPEG frame lengths are always positive, so the zero sentinel lets both current stream formats
// safely share the dedicated Proxy stream WebSocket.
export function encodeDevicePreviewH264ProxyPacket(
  streamId: string,
  packet: DevicePreviewH264Packet,
): Uint8Array {
  const streamIdBytes = new TextEncoder().encode(streamId);
  if (streamIdBytes.length === 0 || streamIdBytes.length > 255) {
    throw new RangeError(`streamId byte length must be 1-255, got ${streamIdBytes.length}`);
  }
  assertPacketSequence(packet.packetSequence);
  assertPacketDuration(packet.durationMs);
  assertAnnexB(packet.annexB);

  const sequenceOffset = H264_PROXY_STREAM_ID_OFFSET + streamIdBytes.length;
  const durationOffset = sequenceOffset + FRAME_SEQUENCE_BYTES;
  const payloadOffset = durationOffset + H264_PACKET_DURATION_BYTES;
  const encoded = new Uint8Array(payloadOffset + packet.annexB.length);
  encoded[0] = DEVICE_PREVIEW_H264_PACKET_SENTINEL;
  encoded[1] = DEVICE_PREVIEW_H264_PACKET_VERSION;
  encoded[2] = h264PacketFlags(packet);
  encoded[H264_PROXY_STREAM_ID_LENGTH_OFFSET] = streamIdBytes.length;
  encoded.set(streamIdBytes, H264_PROXY_STREAM_ID_OFFSET);
  const header = new DataView(
    encoded.buffer,
    encoded.byteOffset + sequenceOffset,
    FRAME_SEQUENCE_BYTES + H264_PACKET_DURATION_BYTES,
  );
  header.setUint32(0, packet.packetSequence, true);
  header.setUint16(FRAME_SEQUENCE_BYTES, packet.durationMs, true);
  encoded.set(packet.annexB, payloadOffset);
  return encoded;
}

export function decodeDevicePreviewH264ProxyPacket(
  view: Uint8Array,
): DecodedDevicePreviewH264ProxyPacket | null {
  if (view.length < DEVICE_PREVIEW_H264_PROXY_PACKET_FIXED_HEADER_BYTES + 1) return null;
  if (
    view[0] !== DEVICE_PREVIEW_H264_PACKET_SENTINEL ||
    view[1] !== DEVICE_PREVIEW_H264_PACKET_VERSION
  ) {
    return null;
  }
  const flags = decodeH264PacketFlags(view[2]!);
  if (!flags) return null;
  const streamIdLength = view[H264_PROXY_STREAM_ID_LENGTH_OFFSET]!;
  if (streamIdLength === 0) return null;
  const sequenceOffset = H264_PROXY_STREAM_ID_OFFSET + streamIdLength;
  const durationOffset = sequenceOffset + FRAME_SEQUENCE_BYTES;
  const payloadOffset = durationOffset + H264_PACKET_DURATION_BYTES;
  if (
    view.length <= payloadOffset ||
    view.length - payloadOffset > DEVICE_PREVIEW_FRAME_MAX_BYTES
  ) {
    return null;
  }

  let streamId: string;
  try {
    streamId = new TextDecoder("utf-8", { fatal: true }).decode(
      view.subarray(H264_PROXY_STREAM_ID_OFFSET, sequenceOffset),
    );
  } catch {
    return null;
  }
  if (!streamId) return null;
  const annexB = view.subarray(payloadOffset);
  if (!isAnnexB(annexB)) return null;
  const header = new DataView(
    view.buffer,
    view.byteOffset + sequenceOffset,
    FRAME_SEQUENCE_BYTES + H264_PACKET_DURATION_BYTES,
  );
  return {
    streamId,
    packetSequence: header.getUint32(0, true),
    ...flags,
    durationMs: header.getUint16(FRAME_SEQUENCE_BYTES, true),
    annexB,
  };
}

// Relay HTTP H.264 record:
//   [1B zero sentinel][1B version][1B flags][4B payload length uint32LE]
//   [4B packet sequence uint32LE][2B durationMs uint16LE][H.264 Annex-B bytes]
export function encodeDevicePreviewH264HttpPacket(packet: DevicePreviewH264Packet): Uint8Array {
  assertPacketSequence(packet.packetSequence);
  assertPacketDuration(packet.durationMs);
  assertAnnexB(packet.annexB);

  const encoded = new Uint8Array(
    DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES + packet.annexB.length,
  );
  encoded[0] = DEVICE_PREVIEW_H264_PACKET_SENTINEL;
  encoded[1] = DEVICE_PREVIEW_H264_PACKET_VERSION;
  encoded[2] = h264PacketFlags(packet);
  const header = new DataView(
    encoded.buffer,
    encoded.byteOffset + H264_HTTP_PAYLOAD_LENGTH_OFFSET,
    H264_PACKET_PAYLOAD_LENGTH_BYTES + FRAME_SEQUENCE_BYTES + H264_PACKET_DURATION_BYTES,
  );
  header.setUint32(0, packet.annexB.length, true);
  header.setUint32(H264_PACKET_PAYLOAD_LENGTH_BYTES, packet.packetSequence, true);
  header.setUint16(
    H264_PACKET_PAYLOAD_LENGTH_BYTES + FRAME_SEQUENCE_BYTES,
    packet.durationMs,
    true,
  );
  encoded.set(packet.annexB, DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES);
  return encoded;
}

export function decodeDevicePreviewH264HttpPacketHeader(
  view: Uint8Array,
): DecodedDevicePreviewH264HttpPacketHeader | null {
  if (view.length < DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES) return null;
  if (
    view[0] !== DEVICE_PREVIEW_H264_PACKET_SENTINEL ||
    view[1] !== DEVICE_PREVIEW_H264_PACKET_VERSION
  ) {
    return null;
  }
  const flags = decodeH264PacketFlags(view[2]!);
  if (!flags) return null;
  const header = new DataView(
    view.buffer,
    view.byteOffset + H264_HTTP_PAYLOAD_LENGTH_OFFSET,
    H264_PACKET_PAYLOAD_LENGTH_BYTES + FRAME_SEQUENCE_BYTES + H264_PACKET_DURATION_BYTES,
  );
  const annexBLength = header.getUint32(0, true);
  if (annexBLength === 0 || annexBLength > DEVICE_PREVIEW_FRAME_MAX_BYTES) return null;
  return {
    annexBLength,
    packetSequence: header.getUint32(H264_PACKET_PAYLOAD_LENGTH_BYTES, true),
    ...flags,
    durationMs: header.getUint16(H264_PACKET_PAYLOAD_LENGTH_BYTES + FRAME_SEQUENCE_BYTES, true),
  };
}
