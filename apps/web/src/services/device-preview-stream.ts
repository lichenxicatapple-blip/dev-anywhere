import {
  DEVICE_PREVIEW_FRAME_MAX_BYTES,
  DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES,
} from "@dev-anywhere/shared";
import { getRelayClientToken } from "@/lib/relay-client-token";

export interface DevicePreviewHttpFrame {
  sequence: number;
  jpeg: Uint8Array;
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

export interface ConsumeDevicePreviewStreamOptions {
  signal: AbortSignal;
  onFrame: (frame: DevicePreviewHttpFrame) => void | Promise<void>;
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

export async function consumeDevicePreviewStream(
  url: string,
  options: ConsumeDevicePreviewStreamOptions,
): Promise<void> {
  // The Relay client token authenticates every machine on a Relay. Never attach it to a URL
  // supplied by a compromised Proxy unless it is the exact same-origin, Relay-owned endpoint.
  assertTrustedDevicePreviewStreamUrl(url);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const clientToken = getRelayClientToken();
  const response = await fetchImpl(url, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    ...(clientToken ? { headers: { Authorization: `Bearer ${clientToken}` } } : {}),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`无法打开模拟器画面（${response.status}）`);
  }

  const parser = new DevicePreviewHttpFrameParser();
  const reader = response.body.getReader();
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
