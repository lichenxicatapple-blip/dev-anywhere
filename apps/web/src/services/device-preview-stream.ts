import {
  DEVICE_PREVIEW_FRAME_MAX_BYTES,
  DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES,
  DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES,
  decodeDevicePreviewH264HttpPacketHeader,
} from "@dev-anywhere/shared";
import { getRelayClientToken } from "@/lib/relay-client-token";

interface DevicePreviewHttpFrame {
  sequence: number;
  jpeg: Uint8Array;
}

interface DevicePreviewHttpH264Packet {
  sequence: number;
  kind: "configuration" | "frame";
  keyframe: boolean;
  durationMs: number;
  data: Uint8Array;
}

interface DevicePreviewStreamSize {
  width: number;
  height: number;
}

/**
 * Parses Relay's length-prefixed device-preview stream without assuming that fetch() chunks line
 * up with records. The parser owns its buffered bytes, so callers may immediately release or
 * reuse the chunks returned by the browser stream.
 */
export class DevicePreviewHttpFrameParser {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): DevicePreviewHttpFrame[] {
    if (chunk.byteLength === 0) return [];
    const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    next.set(this.buffer);
    next.set(chunk, this.buffer.byteLength);
    this.buffer = next;

    const frames: DevicePreviewHttpFrame[] = [];
    let offset = 0;
    while (this.buffer.byteLength - offset >= DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES) {
      const header = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + offset,
        DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES,
      );
      const jpegLength = header.getUint32(0, true);
      const sequence = header.getUint32(4, true);
      if (jpegLength === 0 || jpegLength > DEVICE_PREVIEW_FRAME_MAX_BYTES) {
        this.buffer = new Uint8Array(0);
        throw new RangeError(`Invalid device preview frame length: ${jpegLength}`);
      }

      const recordLength = DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES + jpegLength;
      if (this.buffer.byteLength - offset < recordLength) break;
      frames.push({
        sequence,
        jpeg: this.buffer.slice(
          offset + DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES,
          offset + recordLength,
        ),
      });
      offset += recordLength;
    }

    if (offset > 0) this.buffer = this.buffer.slice(offset);
    if (
      this.buffer.byteLength >
      DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES + DEVICE_PREVIEW_FRAME_MAX_BYTES
    ) {
      this.buffer = new Uint8Array(0);
      throw new RangeError("Device preview stream buffer exceeded its limit");
    }
    return frames;
  }

  finish(): void {
    if (this.buffer.byteLength === 0) return;
    this.buffer = new Uint8Array(0);
    throw new Error("Device preview stream ended with a truncated frame");
  }
}

export class DevicePreviewHttpH264PacketParser {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): DevicePreviewHttpH264Packet[] {
    if (chunk.byteLength === 0) return [];
    const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    next.set(this.buffer);
    next.set(chunk, this.buffer.byteLength);
    this.buffer = next;

    const packets: DevicePreviewHttpH264Packet[] = [];
    let offset = 0;
    while (this.buffer.byteLength - offset >= DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES) {
      const headerView = this.buffer.subarray(offset);
      const header = decodeDevicePreviewH264HttpPacketHeader(headerView);
      if (!header) {
        this.buffer = new Uint8Array(0);
        throw new RangeError("Invalid H.264 device preview packet header");
      }
      const recordLength = DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES + header.annexBLength;
      if (this.buffer.byteLength - offset < recordLength) break;
      packets.push({
        sequence: header.packetSequence,
        kind: header.configuration ? "configuration" : "frame",
        keyframe: header.keyframe,
        durationMs: header.durationMs,
        data: this.buffer.slice(
          offset + DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES,
          offset + recordLength,
        ),
      });
      offset += recordLength;
    }

    if (offset > 0) this.buffer = this.buffer.slice(offset);
    if (
      this.buffer.byteLength >
      DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES + DEVICE_PREVIEW_FRAME_MAX_BYTES
    ) {
      this.buffer = new Uint8Array(0);
      throw new RangeError("H.264 device preview stream buffer exceeded its limit");
    }
    return packets;
  }

  finish(): void {
    if (this.buffer.byteLength === 0) return;
    this.buffer = new Uint8Array(0);
    throw new Error("H.264 device preview stream ended with a truncated packet");
  }
}

interface ConsumeDevicePreviewStreamOptions {
  signal: AbortSignal;
  onFrame: (frame: DevicePreviewHttpFrame) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
}

interface ConsumeDevicePreviewH264StreamOptions {
  signal: AbortSignal;
  onPacket: (packet: DevicePreviewHttpH264Packet) => void | Promise<void>;
  onSize?: (size: DevicePreviewStreamSize) => void;
  fetch?: typeof globalThis.fetch;
}

function assertTrustedDevicePreviewStreamUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value, globalThis.location.href);
  } catch {
    throw new Error("无效的模拟器画面地址");
  }
  if (
    url.origin !== globalThis.location.origin ||
    url.username !== "" ||
    url.password !== "" ||
    !/^\/api\/device-preview-streams\/[A-Za-z0-9_-]{1,256}$/u.test(url.pathname) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("拒绝连接不受信任的模拟器画面地址");
  }
}

function streamSize(response: Response): DevicePreviewStreamSize | null {
  const width = Number(response.headers.get("X-Device-Width"));
  const height = Number(response.headers.get("X-Device-Height"));
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    return null;
  }
  return { width, height };
}

async function fetchDevicePreviewStream(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch,
): Promise<Response> {
  assertTrustedDevicePreviewStreamUrl(url);
  const clientToken = getRelayClientToken();
  const response = await fetchImpl(url, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    ...(clientToken ? { headers: { Authorization: `Bearer ${clientToken}` } } : {}),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`无法打开模拟器画面（${response.status}）`);
  }
  return response;
}

export async function consumeDevicePreviewStream(
  url: string,
  options: ConsumeDevicePreviewStreamOptions,
): Promise<void> {
  // The Relay client token authenticates every machine on a Relay. Never attach it to a URL
  // supplied by a compromised Proxy unless it is the exact same-origin, Relay-owned endpoint.
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchDevicePreviewStream(url, options.signal, fetchImpl);
  if (response.headers.get("X-Device-Preview-Format") !== "jpeg") {
    throw new Error("开发机返回了错误的模拟器画面格式");
  }

  const parser = new DevicePreviewHttpFrameParser();
  const reader = response.body!.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const frames = parser.push(value);
      // A slow decoder must not make latency grow without bound. Every record was validated, but
      // only the newest complete frame in this network chunk is worth painting.
      const latest = frames.at(-1);
      if (latest) await options.onFrame(latest);
    }
    parser.finish();
  } finally {
    reader.releaseLock();
  }
}

export async function consumeDevicePreviewH264Stream(
  url: string,
  options: ConsumeDevicePreviewH264StreamOptions,
): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchDevicePreviewStream(url, options.signal, fetchImpl);
  if (response.headers.get("X-Device-Preview-Format") !== "h264_annex_b") {
    throw new Error("开发机没有返回 H.264 模拟器画面");
  }
  const size = streamSize(response);
  if (size) options.onSize?.(size);

  const parser = new DevicePreviewHttpH264PacketParser();
  const reader = response.body!.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const packet of parser.push(value)) await options.onPacket(packet);
    }
    parser.finish();
  } finally {
    reader.releaseLock();
  }
}
