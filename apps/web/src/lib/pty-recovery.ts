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
  private frameBuffer: Uint8Array[] = [];

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

  handleBinaryFrame(frame: Uint8Array, target: PtyRenderTarget): { written: boolean } {
    if (!this.snapshotApplied) {
      this.frameBuffer.push(frame);
      return { written: false };
    }
    target.write(frame);
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

    target.reset();
    target.resize(snapshot.cols, snapshot.rows);
    target.write(snapshot.data, () => {
      for (const frame of frames) {
        target.write(frame);
      }
    });

    return { applied: true, replayedFrames: frames.length };
  }
}
