type WriteCallback = () => void;

export interface PtyRenderTarget {
  reset: () => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string | Uint8Array, callback?: WriteCallback) => void;
}

interface PtySnapshotMessage {
  requestId?: string;
  cols: number;
  rows: number;
  data: string;
  outputSeq: number;
}

interface PtyRecoveryOptions {
  requestIdFactory?: () => string;
}

type SnapshotResult =
  | { applied: true; replayedFrames: number }
  | { applied: false; reason: "stale_snapshot" | "no_active_request" };

export class PtyRecoveryController {
  private requestIdFactory: () => string;
  private activeRequestId: string | null = null;
  private snapshotApplied = false;
  private frameBuffer: Array<{ data: Uint8Array; outputSeq: number }> = [];
  private appliedOutputSeq = 0;

  constructor(options: PtyRecoveryOptions = {}) {
    let seq = 0;
    this.requestIdFactory = options.requestIdFactory ?? (() => `pty-snapshot-${++seq}`);
  }

  startSnapshotRequest(): string {
    const requestId = this.requestIdFactory();
    this.activeRequestId = requestId;
    this.snapshotApplied = false;
    this.frameBuffer = [];
    return requestId;
  }

  hasAppliedSnapshot(): boolean {
    return this.snapshotApplied;
  }

  handleBinaryFrame(
    frame: { data: Uint8Array; outputSeq: number },
    target: PtyRenderTarget,
  ): { written: boolean } {
    if (!this.snapshotApplied) {
      this.frameBuffer.push(frame);
      return { written: false };
    }
    if (frame.outputSeq <= this.appliedOutputSeq) return { written: false };
    this.appliedOutputSeq = frame.outputSeq;
    target.write(frame.data);
    return { written: true };
  }

  applySnapshot(snapshot: PtySnapshotMessage, target: PtyRenderTarget): SnapshotResult {
    if (!this.activeRequestId) {
      return { applied: false, reason: "no_active_request" };
    }
    if (snapshot.requestId !== this.activeRequestId) {
      return { applied: false, reason: "stale_snapshot" };
    }

    const frames = this.frameBuffer;
    this.frameBuffer = [];
    this.activeRequestId = null;
    this.snapshotApplied = true;
    this.appliedOutputSeq = snapshot.outputSeq;
    const replayFrames = frames.filter((frame) => frame.outputSeq > snapshot.outputSeq);

    target.reset();
    target.resize(snapshot.cols, snapshot.rows);
    target.write(snapshot.data, () => {
      for (const frame of replayFrames) {
        this.appliedOutputSeq = Math.max(this.appliedOutputSeq, frame.outputSeq);
        target.write(frame.data);
      }
    });

    return { applied: true, replayedFrames: replayFrames.length };
  }
}
