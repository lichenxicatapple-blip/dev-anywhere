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
  private pendingFrames = new Map<number, Uint8Array>();
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
    this.pendingFrames.clear();
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
    this.pendingFrames.set(frame.outputSeq, frame.data);
    return { written: this.flushContiguousFrames(target) > 0 };
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
    this.pendingFrames.clear();
    this.activeRequestId = null;
    this.snapshotApplied = true;
    this.appliedOutputSeq = snapshot.outputSeq;
    const replayFrames = frames
      .filter((frame) => frame.outputSeq > snapshot.outputSeq)
      .sort((a, b) => a.outputSeq - b.outputSeq);

    target.reset();
    target.resize(snapshot.cols, snapshot.rows);
    target.write(snapshot.data, () => {
      for (const frame of replayFrames) {
        this.pendingFrames.set(frame.outputSeq, frame.data);
      }
      this.flushContiguousFrames(target);
    });

    return { applied: true, replayedFrames: replayFrames.length };
  }

  private flushContiguousFrames(target: PtyRenderTarget): number {
    let written = 0;
    let nextSeq = this.appliedOutputSeq + 1;
    while (this.pendingFrames.has(nextSeq)) {
      const data = this.pendingFrames.get(nextSeq)!;
      this.pendingFrames.delete(nextSeq);
      this.appliedOutputSeq = nextSeq;
      target.write(data);
      written += 1;
      nextSeq += 1;
    }
    return written;
  }
}
