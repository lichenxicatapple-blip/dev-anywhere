declare module "jmuxer" {
  export type JMuxerMode = "audio" | "both" | "video";

  export interface JMuxerBufferError {
    type?: string;
    name?: string;
    error?: unknown;
  }

  export interface JMuxerOptions {
    node: HTMLVideoElement | string;
    mode?: JMuxerMode;
    videoCodec?: "H264" | "H265";
    flushingTime?: number;
    maxDelay?: number;
    clearBuffer?: boolean;
    fps?: number;
    readFpsFromTrack?: boolean;
    debug?: boolean;
    onReady?: (isReset: boolean, mediaSource: MediaSource) => void;
    onData?: (data: Uint8Array) => void;
    onError?: (error: JMuxerBufferError) => void;
    onUnsupportedCodec?: (codec: string) => void;
    onMissingVideoFrames?: () => void;
    onMissingAudioFrames?: () => void;
    onKeyframePosition?: (time: number) => void;
    onLoggerLog?: (...values: unknown[]) => void;
    onLoggerErr?: (...values: unknown[]) => void;
  }

  export interface JMuxerFeedData {
    video?: Uint8Array;
    audio?: Uint8Array;
    duration?: number;
    compositionTimeOffset?: number;
    isLastVideoFrameComplete?: boolean;
  }

  export default class JMuxer {
    constructor(options: JMuxerOptions);

    static isSupported(codec: string): boolean;

    feed(data: JMuxerFeedData): void;
    reset(): void;
    destroy(): void;
  }
}
