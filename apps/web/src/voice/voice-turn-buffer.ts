interface VoiceTurnBufferSnapshot {
  draft: string;
  partial: string;
  hasDraft: boolean;
}

type VoiceTurnTimer = ReturnType<typeof setTimeout>;
type VoiceTurnSetTimeout = (handler: () => void, timeoutMs: number) => VoiceTurnTimer;
type VoiceTurnClearTimeout = (timer: VoiceTurnTimer) => void;

interface VoiceTurnBufferOptions {
  idleTimeoutMs: number;
  onTurnReady: (text: string) => void;
  setTimeoutFn?: VoiceTurnSetTimeout;
  clearTimeoutFn?: VoiceTurnClearTimeout;
}

export class VoiceTurnBuffer {
  private readonly idleTimeoutMs: number;
  private readonly onTurnReady: (text: string) => void;
  private readonly setTimeoutFn: VoiceTurnSetTimeout;
  private readonly clearTimeoutFn: VoiceTurnClearTimeout;
  private finalSegments: string[] = [];
  private partialText = "";
  private idleTimer: VoiceTurnTimer | null = null;

  constructor(options: VoiceTurnBufferOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.onTurnReady = options.onTurnReady;
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer));
  }

  appendPartial(text: string): void {
    const trimmed = text.trim();
    this.partialText = trimmed;
    if (trimmed) {
      this.restartIdleTimer();
      return;
    }
    if (this.finalSegments.length === 0) {
      this.clearIdleTimer();
    }
  }

  appendFinal(text: string): void {
    const trimmed = text.trim();
    this.partialText = "";
    if (!trimmed) {
      this.clearIdleTimer();
      return;
    }
    this.finalSegments.push(trimmed);
    this.restartIdleTimer();
  }

  cancel(): void {
    this.finalSegments = [];
    this.partialText = "";
    this.clearIdleTimer();
  }

  flushNow(): void {
    this.clearIdleTimer();
    this.emitIfReady();
  }

  dispose(): void {
    this.cancel();
  }

  getSnapshot(): VoiceTurnBufferSnapshot {
    return {
      draft: this.finalSegments.join("\n"),
      partial: this.partialText,
      hasDraft: this.finalSegments.length > 0,
    };
  }

  private restartIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = this.setTimeoutFn(() => this.emitIfReady(), this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    this.clearTimeoutFn(this.idleTimer);
    this.idleTimer = null;
  }

  private emitIfReady(): void {
    this.clearIdleTimer();
    const segments = [...this.finalSegments];
    if (this.partialText) segments.push(this.partialText);
    const text = segments.join("\n").trim();
    this.finalSegments = [];
    this.partialText = "";
    if (!text) return;
    this.onTurnReady(text);
  }
}
