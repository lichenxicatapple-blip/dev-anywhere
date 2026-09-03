import type JMuxer from "jmuxer";
import type { JMuxerBufferError, JMuxerOptions } from "jmuxer";

const DEFAULT_MAX_BUFFERED_PACKETS = 120;
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const FALLBACK_FRAME_DURATION_MS = 1000 / 30;
const MAX_PLAYBACK_DELAY_SECONDS = 0.15;
const PLAYBACK_DELAY_CHECK_MS = 100;
const LIVE_EDGE_CLEARANCE_SECONDS = 0.001;

interface DevicePreviewH264Packet {
  kind: "configuration" | "frame";
  keyframe: boolean;
  durationMs: number;
  data: Uint8Array;
}

interface DevicePreviewH264PlayerOptions {
  /** Called once playback has actually started, rather than merely when MSE opens. */
  onStart?: () => void;
  onError?: (error: Error) => void;
  /**
   * Called when the bounded player buffer can no longer preserve a complete GOP. The caller
   * should abort the current stream and reconnect so the Proxy sends fresh configuration + IDR.
   */
  onResyncRequired?: (error: Error) => void;
  /** Primarily useful for deterministic tests; production callers should use the defaults. */
  maxBufferedPackets?: number;
  /** Primarily useful for deterministic tests; production callers should use the defaults. */
  maxBufferedBytes?: number;
}

interface VideoElementState {
  autoplay: boolean;
  disableRemotePlayback: boolean;
  muted: boolean;
  playsInline: boolean;
  src: string | null;
  srcObject: MediaProvider | null;
}

interface PendingFrame {
  data: Uint8Array;
  durationMs: number;
  keyframe: boolean;
}

interface FedFrameBudget {
  byteLength: number;
  remainingDurationMs: number;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string" && value.length > 0) return new Error(value);
  if (value && typeof value === "object") {
    const candidate = value as { error?: unknown; message?: unknown; name?: unknown };
    const details = [candidate.name, candidate.message, candidate.error]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(": ");
    if (details.length > 0) return new Error(details);
  }
  return new Error(fallback);
}

function mediaError(video: HTMLVideoElement): Error {
  const error = video.error;
  if (!error) return new Error("H.264 video playback failed");
  const message = error.message || `media error ${error.code}`;
  return new Error(`H.264 video playback failed: ${message}`);
}

/**
 * Feeds complete Annex-B access units into JMuxer while keeping MSE lifecycle details out of
 * the React page. A decoder generation never receives delta frames before its first keyframe.
 */
export class DevicePreviewH264Player {
  private muxer: JMuxer | null = null;
  private readonly initialSources: Set<HTMLSourceElement>;
  private readonly initialVideoState: VideoElementState;
  private configuration: Uint8Array | null = null;
  private configurationApplied = false;
  private muxerReady = false;
  private awaitingKeyframe = true;
  private pendingFrames: PendingFrame[] = [];
  private fedFramesAwaitingPlayback: FedFrameBudget[] = [];
  private bufferedPacketCount = 0;
  private bufferedBytes = 0;
  private readonly maxBufferedPackets: number;
  private readonly maxBufferedBytes: number;
  private lastObservedMediaTime: number | null = null;
  private resyncRequired = false;
  private playPending = false;
  private playRequested = false;
  private started = false;
  private destroyed = false;
  private generation = 0;
  private playbackDelayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly options: DevicePreviewH264PlayerOptions = {},
  ) {
    this.maxBufferedPackets = positiveInteger(
      options.maxBufferedPackets,
      DEFAULT_MAX_BUFFERED_PACKETS,
    );
    this.maxBufferedBytes = positiveInteger(options.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES);
    this.initialSources = new Set(video.querySelectorAll("source"));
    this.initialVideoState = {
      autoplay: video.autoplay,
      disableRemotePlayback: video.disableRemotePlayback,
      muted: video.muted,
      playsInline: video.playsInline,
      src: video.getAttribute("src"),
      srcObject: video.srcObject,
    };

    video.srcObject = null;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.disableRemotePlayback = true;
    video.addEventListener("playing", this.handlePlaying);
    video.addEventListener("error", this.handleVideoError);
    video.addEventListener("timeupdate", this.handleTimeUpdate);

    const muxerOptions: JMuxerOptions = {
      node: video,
      mode: "video",
      flushingTime: 0,
      maxDelay: 150,
      clearBuffer: true,
      onReady: () => this.handleMuxerReady(),
      onError: (error) => this.handleMuxerError(error),
      onUnsupportedCodec: (codec) => {
        this.reportError(new Error(`Browser does not support the H.264 codec ${codec}`));
      },
    };

    void this.initializeMuxer(muxerOptions);
  }

  feed(packet: DevicePreviewH264Packet): void {
    if (this.destroyed || packet.data.byteLength === 0) return;
    this.observePlaybackProgress();
    if (packet.kind === "configuration") {
      this.feedConfiguration(packet.data);
      return;
    }
    this.feedFrame(packet);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.clearBufferedGeneration();
    this.video.removeEventListener("playing", this.handlePlaying);
    this.video.removeEventListener("error", this.handleVideoError);
    this.video.removeEventListener("timeupdate", this.handleTimeUpdate);
    this.stopPlaybackDelayChecks();

    const objectUrls = this.generatedObjectUrls();
    try {
      this.muxer?.destroy();
    } catch {
      // Continue releasing the media element even if the third-party teardown fails.
    }
    this.muxer = null;

    try {
      this.video.pause();
    } catch {
      // Some test and embedded media elements do not implement pause().
    }
    this.removeGeneratedSources();
    this.video.removeAttribute("src");
    if (this.initialVideoState.src !== null) {
      this.video.setAttribute("src", this.initialVideoState.src);
    }
    this.video.srcObject = this.initialVideoState.srcObject;
    this.video.autoplay = this.initialVideoState.autoplay;
    this.video.disableRemotePlayback = this.initialVideoState.disableRemotePlayback;
    this.video.muted = this.initialVideoState.muted;
    this.video.playsInline = this.initialVideoState.playsInline;
    for (const url of objectUrls) this.revokeObjectUrl(url);
    try {
      this.video.load();
    } catch {
      // Loading is best-effort cleanup in non-browser test environments.
    }
  }

  private async initializeMuxer(options: JMuxerOptions): Promise<void> {
    try {
      const { default: JMuxerConstructor } = await import("jmuxer");
      if (this.destroyed) return;
      this.muxer = new JMuxerConstructor(options);
    } catch (error) {
      if (this.destroyed) return;
      this.reportError(toError(error, "Failed to initialize H.264 video playback"));
      this.destroy();
    }
  }

  private feedConfiguration(data: Uint8Array): void {
    if (this.configuration && bytesEqual(this.configuration, data)) return;

    const replacesAppliedConfiguration = this.configuration !== null && this.configurationApplied;
    this.clearBufferedGeneration();
    if (this.wouldOverflow(data.byteLength)) {
      this.requireResync();
      return;
    }
    this.configuration = data.slice();
    this.addBufferedPacket(data.byteLength);
    this.awaitingKeyframe = true;

    if (replacesAppliedConfiguration) {
      this.resetMuxer();
      return;
    }
    this.applyConfigurationIfReady();
  }

  private feedFrame(packet: DevicePreviewH264Packet): void {
    if (!this.configuration) return;
    if (this.awaitingKeyframe) {
      if (!packet.keyframe) return;
      this.awaitingKeyframe = false;
      this.resyncRequired = false;
    }

    const frame: PendingFrame = {
      data: packet.data.slice(),
      durationMs:
        Number.isFinite(packet.durationMs) && packet.durationMs > 0
          ? packet.durationMs
          : FALLBACK_FRAME_DURATION_MS,
      keyframe: packet.keyframe,
    };
    // A newer IDR makes queued, not-yet-fed frames obsolete and keeps latency bounded. Frames
    // already handed to JMuxer stay in the conservative playback budget until media time covers
    // them; JMuxer exposes no append acknowledgement that could safely release them sooner.
    if (frame.keyframe) this.clearPendingFrames();
    if (this.wouldOverflow(frame.data.byteLength)) {
      this.requireResync();
      return;
    }
    this.addBufferedPacket(frame.data.byteLength);
    if (!this.muxerReady || !this.configurationApplied) {
      this.pendingFrames.push(frame);
      return;
    }
    if (!this.applyFrame(frame)) this.removeBufferedPacket(frame.data.byteLength);
  }

  private resetMuxer(): void {
    const previousSources = this.generatedSources();
    const previousUrls = this.generatedObjectUrls();
    this.generation += 1;
    this.muxerReady = false;
    this.configurationApplied = false;
    this.awaitingKeyframe = true;
    this.playPending = false;
    this.playRequested = false;
    this.stopPlaybackDelayChecks();
    try {
      this.muxer?.reset();
    } catch (error) {
      this.reportError(toError(error, "Failed to reset H.264 video playback"));
    }
    for (const source of previousSources) source.remove();
    for (const url of previousUrls) this.revokeObjectUrl(url);
  }

  private handleMuxerReady(): void {
    if (this.destroyed) return;
    this.muxerReady = true;
    this.startPlaybackDelayChecks();
    this.applyConfigurationIfReady();
    this.flushPendingFrames();
  }

  private startPlaybackDelayChecks(): void {
    if (this.playbackDelayTimer !== null) return;
    this.playbackDelayTimer = setInterval(() => {
      this.catchUpToLiveEdge();
    }, PLAYBACK_DELAY_CHECK_MS);
  }

  private stopPlaybackDelayChecks(): void {
    if (this.playbackDelayTimer === null) return;
    clearInterval(this.playbackDelayTimer);
    this.playbackDelayTimer = null;
  }

  private catchUpToLiveEdge(): void {
    if (this.destroyed || this.video.seeking) return;
    const buffered = this.video.buffered;
    if (buffered.length === 0) return;
    try {
      const liveEdge = buffered.end(buffered.length - 1);
      const mediaTime = this.video.currentTime;
      if (
        !Number.isFinite(liveEdge) ||
        !Number.isFinite(mediaTime) ||
        liveEdge - mediaTime <= MAX_PLAYBACK_DELAY_SECONDS
      ) {
        return;
      }
      this.video.currentTime = Math.max(0, liveEdge - LIVE_EDGE_CLEARANCE_SECONDS);
      this.observePlaybackProgress();
    } catch {
      // MediaSource can replace its TimeRanges between the length and end() reads during reset.
    }
  }

  private applyConfigurationIfReady(): void {
    if (
      this.destroyed ||
      !this.muxerReady ||
      this.configurationApplied ||
      !this.configuration ||
      !this.muxer
    ) {
      return;
    }
    try {
      this.muxer.feed({
        video: this.configuration,
        duration: 0,
        isLastVideoFrameComplete: true,
      });
      this.configurationApplied = true;
      this.flushPendingFrames();
    } catch (error) {
      this.reportError(toError(error, "Failed to apply H.264 decoder configuration"));
    }
  }

  private applyFrame(frame: PendingFrame): boolean {
    if (this.destroyed || !this.muxer) return false;
    try {
      this.muxer.feed({
        video: frame.data,
        duration: frame.durationMs,
        isLastVideoFrameComplete: true,
      });
      this.fedFramesAwaitingPlayback.push({
        byteLength: frame.data.byteLength,
        remainingDurationMs: frame.durationMs,
      });
      this.attemptPlayback();
      return true;
    } catch (error) {
      this.reportError(toError(error, "Failed to feed an H.264 video frame"));
      return false;
    }
  }

  private flushPendingFrames(): void {
    if (this.destroyed || !this.muxerReady || !this.configurationApplied || !this.muxer) return;
    this.observePlaybackProgress();
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    for (const frame of frames) {
      if (this.destroyed) return;
      if (!this.applyFrame(frame)) this.removeBufferedPacket(frame.data.byteLength);
    }
  }

  private attemptPlayback(): void {
    if (this.destroyed || this.playPending || this.playRequested) return;
    this.playPending = true;
    this.playRequested = true;
    const generation = this.generation;
    let result: Promise<void>;
    try {
      result = this.video.play();
    } catch (error) {
      this.playPending = false;
      this.playRequested = false;
      this.reportError(toError(error, "Browser blocked H.264 video playback"));
      return;
    }
    void result.then(
      () => {
        if (this.destroyed || generation !== this.generation) return;
        this.playPending = false;
        this.markStarted();
      },
      (error) => {
        if (this.destroyed || generation !== this.generation) return;
        this.playPending = false;
        this.playRequested = false;
        this.reportError(toError(error, "Browser blocked H.264 video playback"));
      },
    );
  }

  private readonly handlePlaying = (): void => {
    if (this.destroyed) return;
    this.observePlaybackProgress();
    this.playRequested = true;
    this.markStarted();
  };

  private readonly handleTimeUpdate = (): void => {
    this.observePlaybackProgress();
  };

  private readonly handleVideoError = (): void => {
    if (!this.destroyed) this.reportError(mediaError(this.video));
  };

  private handleMuxerError(error: JMuxerBufferError): void {
    if (this.destroyed) return;
    if (error.name === "InvalidStateError") {
      // JMuxer has already rebuilt its MediaSource before invoking this callback.
      this.generation += 1;
      this.muxerReady = false;
      this.configurationApplied = false;
      this.awaitingKeyframe = true;
      this.clearBufferedGeneration();
      this.playPending = false;
      this.playRequested = false;
      this.stopPlaybackDelayChecks();
    }
    this.reportError(toError(error, "H.264 video buffer failed"));
  }

  private markStarted(): void {
    if (this.started) return;
    this.started = true;
    this.options.onStart?.();
  }

  private reportError(error: Error): void {
    if (!this.destroyed) this.options.onError?.(error);
  }

  private observePlaybackProgress(): void {
    const mediaTime = this.video.currentTime;
    if (!Number.isFinite(mediaTime) || mediaTime < 0) return;
    if (this.lastObservedMediaTime === null || mediaTime < this.lastObservedMediaTime) {
      this.lastObservedMediaTime = mediaTime;
      return;
    }
    let elapsedMs = (mediaTime - this.lastObservedMediaTime) * 1000;
    this.lastObservedMediaTime = mediaTime;
    if (elapsedMs <= 0) return;

    while (elapsedMs > 0) {
      const frame = this.fedFramesAwaitingPlayback[0];
      if (!frame) return;
      if (elapsedMs + Number.EPSILON < frame.remainingDurationMs) {
        frame.remainingDurationMs -= elapsedMs;
        return;
      }
      elapsedMs -= frame.remainingDurationMs;
      this.fedFramesAwaitingPlayback.shift();
      this.removeBufferedPacket(frame.byteLength);
    }
  }

  private wouldOverflow(byteLength: number): boolean {
    return (
      this.bufferedPacketCount + 1 > this.maxBufferedPackets ||
      this.bufferedBytes + byteLength > this.maxBufferedBytes
    );
  }

  private addBufferedPacket(byteLength: number): void {
    this.bufferedPacketCount += 1;
    this.bufferedBytes += byteLength;
  }

  private removeBufferedPacket(byteLength: number): void {
    this.bufferedPacketCount = Math.max(0, this.bufferedPacketCount - 1);
    this.bufferedBytes = Math.max(0, this.bufferedBytes - byteLength);
  }

  private clearPendingFrames(): void {
    for (const frame of this.pendingFrames) this.removeBufferedPacket(frame.data.byteLength);
    this.pendingFrames = [];
  }

  private clearBufferedGeneration(): void {
    this.pendingFrames = [];
    this.fedFramesAwaitingPlayback = [];
    this.configuration = null;
    this.configurationApplied = false;
    this.bufferedPacketCount = 0;
    this.bufferedBytes = 0;
    this.lastObservedMediaTime = null;
  }

  private requireResync(): void {
    const shouldNotify = !this.resyncRequired;
    this.resyncRequired = true;
    this.clearBufferedGeneration();
    this.awaitingKeyframe = true;
    this.resetMuxer();
    if (shouldNotify && !this.destroyed) {
      this.options.onResyncRequired?.(
        new Error("H.264 playback buffer overflowed; reconnecting for a fresh keyframe"),
      );
    }
  }

  private generatedSources(): HTMLSourceElement[] {
    return Array.from(this.video.querySelectorAll("source")).filter(
      (source) => !this.initialSources.has(source),
    );
  }

  private removeGeneratedSources(): void {
    for (const source of this.generatedSources()) source.remove();
  }

  private generatedObjectUrls(): string[] {
    const urls = new Set<string>();
    const src = this.video.getAttribute("src");
    if (src !== this.initialVideoState.src && src?.startsWith("blob:")) urls.add(src);
    for (const source of this.generatedSources()) {
      const sourceUrl = source.getAttribute("src");
      if (sourceUrl?.startsWith("blob:")) urls.add(sourceUrl);
    }
    return [...urls];
  }

  private revokeObjectUrl(url: string): void {
    if (typeof URL.revokeObjectURL !== "function") return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Revocation is idempotent in browsers, but keep cleanup defensive for test shims.
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
