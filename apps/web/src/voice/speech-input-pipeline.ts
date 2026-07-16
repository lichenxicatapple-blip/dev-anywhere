export interface SpeechAudioStream {
  send(chunk: Uint8Array): void;
  finish(): void;
  abort(): void;
}

export type SpeechInputPipelineState =
  | "armed"
  | "opening"
  | "streaming"
  | "finishing"
  | "complete"
  | "cancelled";

interface SpeechInputPipelineOptions {
  preRollBytes: number;
  openStream: () => Promise<SpeechAudioStream>;
  onError: (error: unknown) => void;
}

export interface SpeechInputPipelineSnapshot {
  state: SpeechInputPipelineState;
  preRollBytes: number;
  pendingBytes: number;
  speechEnded: boolean;
}

export class SpeechInputPipeline {
  private readonly options: SpeechInputPipelineOptions;
  private state: SpeechInputPipelineState = "armed";
  private preRoll: Uint8Array[] = [];
  private preRollBytes = 0;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private stream: SpeechAudioStream | null = null;
  private speechEnded = false;

  constructor(options: SpeechInputPipelineOptions) {
    this.options = options;
  }

  pushFrame(frame: Uint8Array): void {
    if (this.state === "armed") {
      this.appendPreRoll(frame);
      return;
    }
    if (this.state === "opening") {
      this.appendPending(frame);
      return;
    }
    if (this.state === "streaming") {
      this.stream?.send(frame);
    }
  }

  speechStarted(): void {
    if (this.state !== "armed") return;
    this.state = "opening";
    this.pending = this.preRoll;
    this.pendingBytes = this.preRollBytes;
    this.preRoll = [];
    this.preRollBytes = 0;

    void this.options
      .openStream()
      .then((stream) => {
        if (this.state === "cancelled") {
          stream.abort();
          return;
        }
        if (this.state !== "opening") {
          stream.abort();
          return;
        }
        this.stream = stream;
        for (const frame of this.pending) stream.send(frame);
        this.pending = [];
        this.pendingBytes = 0;
        if (this.speechEnded) {
          this.state = "finishing";
          stream.finish();
          this.state = "complete";
          return;
        }
        this.state = "streaming";
      })
      .catch((error: unknown) => {
        if (this.state === "cancelled") return;
        this.state = "complete";
        this.pending = [];
        this.pendingBytes = 0;
        this.options.onError(error);
      });
  }

  speechFinished(): void {
    if (this.state === "armed" || this.state === "complete" || this.state === "cancelled") return;
    this.speechEnded = true;
    if (this.state === "streaming") {
      this.state = "finishing";
      this.stream?.finish();
      this.state = "complete";
    }
  }

  cancel(): void {
    if (this.state === "cancelled") return;
    const shouldAbortStream = this.state !== "complete";
    this.state = "cancelled";
    this.preRoll = [];
    this.preRollBytes = 0;
    this.pending = [];
    this.pendingBytes = 0;
    if (shouldAbortStream) this.stream?.abort();
    this.stream = null;
  }

  snapshot(): SpeechInputPipelineSnapshot {
    return {
      state: this.state,
      preRollBytes: this.preRollBytes,
      pendingBytes: this.pendingBytes,
      speechEnded: this.speechEnded,
    };
  }

  private appendPreRoll(frame: Uint8Array): void {
    const copy = frame.slice();
    this.preRoll.push(copy);
    this.preRollBytes += copy.byteLength;
    while (this.preRollBytes > this.options.preRollBytes && this.preRoll.length > 1) {
      const removed = this.preRoll.shift();
      this.preRollBytes -= removed?.byteLength ?? 0;
    }
  }

  private appendPending(frame: Uint8Array): void {
    const copy = frame.slice();
    this.pending.push(copy);
    this.pendingBytes += copy.byteLength;
  }
}
