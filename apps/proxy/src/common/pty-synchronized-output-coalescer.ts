const SYNC_OUTPUT_START = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";

const DEFAULT_SYNC_OUTPUT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const DEFAULT_SYNC_OUTPUT_IDLE_TIMEOUT_MS = 2_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface PtySynchronizedOutputOverflow {
  reason: "byte-cap";
  maxBufferedBytes: number;
  bufferedBytes: number;
  incomingBytes: number;
  transactionBytes: number;
}

interface PtySynchronizedOutputCoalescerOptions {
  emit: (data: string) => void;
  maxBufferedBytes?: number;
  idleTimeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onOverflow?: (event: PtySynchronizedOutputOverflow) => void;
}

type StreamMode = "outside" | "buffering" | "passthrough";
type ParserState =
  | "ground"
  | "escape"
  | "escape-other"
  | "csi"
  | "osc"
  | "dcs"
  | "apc"
  | "pm"
  | "sos"
  | "string-escape";
type StringState = Extract<ParserState, "osc" | "dcs" | "apc" | "pm" | "sos">;
type SyncMarker = "start" | "end";

/**
 * Coalesces complete DEC synchronized-output transactions before they enter the canonical PTY
 * render stream. The scanner understands enough ECMA-48 framing to only recognize DECSET/DECRST
 * 2026 at the top level; marker-shaped bytes inside terminal strings remain ordinary payload.
 *
 * Transactions which exceed the byte cap, go idle without an end marker, or are explicitly
 * flushed are emitted byte-for-byte. Overflow/idle output stays in passthrough mode until the
 * matching reset marker so a later nested-looking start cannot create a truncated transaction.
 */
export class PtySynchronizedOutputCoalescer {
  private readonly emitData: (data: string) => void;
  private readonly maxBufferedBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly onOverflow?: (event: PtySynchronizedOutputOverflow) => void;

  private mode: StreamMode = "outside";
  private parserState: ParserState = "ground";
  private stringState: StringState | null = null;
  private controlSequence = "";
  private markerEligible = false;
  private outsidePending = "";
  private transactionParts: string[] = [];
  private transactionBytes = 0;
  private idleTimer: TimerHandle | null = null;
  private disposed = false;

  constructor(options: PtySynchronizedOutputCoalescerOptions) {
    this.emitData = options.emit;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_SYNC_OUTPUT_MAX_BUFFERED_BYTES;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SYNC_OUTPUT_IDLE_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.onOverflow = options.onOverflow;

    if (!Number.isSafeInteger(this.maxBufferedBytes) || this.maxBufferedBytes < 1) {
      throw new RangeError("maxBufferedBytes must be a positive safe integer");
    }
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 0) {
      throw new RangeError("idleTimeoutMs must be a non-negative finite number");
    }
  }

  push(data: string): void {
    if (this.disposed || data.length === 0) return;

    let offset = 0;
    for (let index = 0; index < data.length; index += 1) {
      const marker = this.scan(data[index]!);
      if (marker === null) continue;

      const segment = data.slice(offset, index + 1);
      if (this.mode === "outside") {
        if (marker !== "start") continue;
        const combined = this.outsidePending + segment;
        const markerStart = combined.length - SYNC_OUTPUT_START.length;
        this.emit(combined.slice(0, markerStart));
        this.outsidePending = "";
        this.mode = "buffering";
        this.appendTransaction(combined.slice(markerStart));
      } else if (this.mode === "buffering") {
        this.appendTransaction(segment);
        if (marker === "end" && this.mode === "buffering") {
          this.commitTransaction();
        } else if (marker === "end") {
          this.mode = "outside";
        }
      } else {
        this.emit(segment);
        if (marker === "end") this.mode = "outside";
      }
      offset = index + 1;
    }

    const remainder = data.slice(offset);
    if (this.mode === "buffering") {
      this.appendTransaction(remainder);
      if (this.mode === "buffering") this.armIdleTimer();
      return;
    }
    if (this.mode === "passthrough") {
      this.emit(remainder);
      return;
    }

    this.outsidePending += remainder;
    const candidateLength = this.startCandidateLength();
    const emitLength = this.outsidePending.length - candidateLength;
    if (emitLength > 0) {
      this.emit(this.outsidePending.slice(0, emitLength));
      this.outsidePending = this.outsidePending.slice(emitLength);
    }
    if (this.outsidePending.length > 0) this.armIdleTimer();
    else this.clearIdleTimer();
  }

  flush(): void {
    if (this.disposed) return;
    this.clearIdleTimer();
    const wasBuffering = this.mode === "buffering";
    this.emit(this.outsidePending);
    this.outsidePending = "";
    this.emitTransactionParts();
    if (wasBuffering) {
      this.mode = "passthrough";
    } else if (this.mode === "outside") {
      this.disarmCurrentMarkerCandidate();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
  }

  private appendTransaction(data: string): void {
    if (!data) return;
    const incomingBytes = Buffer.byteLength(data, "utf8");
    const nextBytes = this.transactionBytes + incomingBytes;
    if (nextBytes <= this.maxBufferedBytes) {
      this.transactionParts.push(data);
      this.transactionBytes = nextBytes;
      return;
    }

    this.onOverflow?.({
      reason: "byte-cap",
      maxBufferedBytes: this.maxBufferedBytes,
      bufferedBytes: this.transactionBytes,
      incomingBytes,
      transactionBytes: nextBytes,
    });
    this.clearIdleTimer();
    this.emitTransactionParts();
    this.emit(data);
    this.mode = "passthrough";
  }

  private commitTransaction(): void {
    this.clearIdleTimer();
    const transaction = this.transactionParts.join("");
    this.transactionParts = [];
    this.transactionBytes = 0;
    this.mode = "outside";
    this.emit(transaction);
  }

  private emitTransactionParts(): void {
    if (this.transactionParts.length === 0) return;
    this.emit(this.transactionParts.join(""));
    this.transactionParts = [];
    this.transactionBytes = 0;
  }

  private emit(data: string): void {
    if (data) this.emitData(data);
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      if (this.mode === "buffering") {
        this.emitTransactionParts();
        this.mode = "passthrough";
        return;
      }
      if (this.mode === "outside" && this.outsidePending) {
        this.emit(this.outsidePending);
        this.outsidePending = "";
        this.disarmCurrentMarkerCandidate();
      }
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    this.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  private startCandidateLength(): number {
    if (
      (this.parserState === "escape" || this.parserState === "csi") &&
      this.markerEligible &&
      SYNC_OUTPUT_START.startsWith(this.controlSequence)
    ) {
      return this.controlSequence.length;
    }
    return 0;
  }

  private scan(char: string): SyncMarker | null {
    if (this.parserState === "ground") {
      if (char === "\x1b") {
        this.parserState = "escape";
        this.controlSequence = char;
        this.markerEligible = true;
      }
      return null;
    }

    if (this.parserState === "escape") {
      if (char === "[") {
        this.parserState = "csi";
        this.controlSequence += char;
      } else if (char === "]") {
        this.enterString("osc");
      } else if (char === "P") {
        this.enterString("dcs");
      } else if (char === "_") {
        this.enterString("apc");
      } else if (char === "^") {
        this.enterString("pm");
      } else if (char === "X") {
        this.enterString("sos");
      } else if (char === "\x1b") {
        this.controlSequence = char;
        this.markerEligible = true;
      } else if (isEscapeIntermediate(char)) {
        this.parserState = "escape-other";
        this.controlSequence = "";
        this.markerEligible = false;
      } else {
        this.parserState = "ground";
        this.controlSequence = "";
        this.markerEligible = false;
      }
      return null;
    }

    if (this.parserState === "escape-other") {
      if (char === "\x1b") {
        this.parserState = "escape";
        this.controlSequence = char;
        this.markerEligible = true;
      } else if (isFinalByte(char)) {
        this.parserState = "ground";
      }
      return null;
    }

    if (this.parserState === "csi") {
      if (char === "\x1b") {
        this.parserState = "escape";
        this.controlSequence = char;
        this.markerEligible = true;
        return null;
      }
      this.controlSequence += char;
      if (!isFinalByte(char)) return null;

      const sequence = this.controlSequence;
      const markerEligible = this.markerEligible;
      this.parserState = "ground";
      this.controlSequence = "";
      this.markerEligible = false;
      if (markerEligible && sequence === SYNC_OUTPUT_START) return "start";
      if (markerEligible && sequence === SYNC_OUTPUT_END) return "end";
      return null;
    }

    if (this.parserState === "string-escape") {
      if (char === "\\") {
        this.parserState = "ground";
        this.stringState = null;
      } else if (char !== "\x1b") {
        this.parserState = this.stringState ?? "ground";
      }
      return null;
    }

    if (char === "\x1b") {
      this.stringState = this.parserState;
      this.parserState = "string-escape";
    } else if (char === "\x9c" || (this.parserState === "osc" && char === "\x07")) {
      this.parserState = "ground";
      this.stringState = null;
    }
    return null;
  }

  private enterString(state: StringState): void {
    this.parserState = state;
    this.stringState = state;
    this.controlSequence = "";
    this.markerEligible = false;
  }

  private disarmCurrentMarkerCandidate(): void {
    if (this.parserState === "escape" || this.parserState === "csi") {
      this.markerEligible = false;
    }
  }
}

function isFinalByte(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function isEscapeIntermediate(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x20 && code <= 0x2f;
}
