import pkg from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";

const { Terminal: HeadlessTerminal } = pkg;

export interface PtySnapshot {
  cols: number;
  rows: number;
  data: string;
  outputSeq: number;
}

interface PtyRenderSequencerOptions {
  cols: number;
  rows: number;
  scrollback?: number;
}

/**
 * Owns the canonical headless terminal and the sequence shared by every remote render event.
 *
 * xterm processes write callbacks in FIFO order. Resize and snapshot therefore use empty writes
 * as barriers: their terminal reads/mutations happen after earlier writes and before later writes.
 * Keeping all four operations here prevents a snapshot from pairing an old sequence watermark with
 * geometry from a later resize.
 */
export class PtyRenderSequencer {
  private readonly terminal: InstanceType<typeof HeadlessTerminal>;
  private readonly serializeAddon = new SerializeAddon();
  private outputSeq = 0;
  private disposed = false;

  constructor(options: PtyRenderSequencerOptions) {
    this.terminal = new HeadlessTerminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback ?? 5000,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializeAddon);
    this.terminal.loadAddon(new UnicodeGraphemesAddon());
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  /** Queues non-empty render output and returns its allocated remote event sequence. */
  write(data: string | Uint8Array): number | null {
    if (this.disposed || data.length === 0) return null;
    const outputSeq = ++this.outputSeq;
    this.terminal.write(data);
    return outputSeq;
  }

  /**
   * Allocates a resize event and queues the geometry change at its exact place in xterm's write
   * stream. Output queued after this call cannot be parsed using the old geometry.
   */
  resize(cols: number, rows: number): number | null {
    if (this.disposed) return null;
    const outputSeq = ++this.outputSeq;
    this.terminal.write("", () => {
      if (this.disposed) return;
      this.terminal.resize(cols, rows);
    });
    return outputSeq;
  }

  /** Captures the sequence watermark now and the matching terminal state at the FIFO barrier. */
  captureSnapshot(onSnapshot: (snapshot: PtySnapshot) => void): boolean {
    if (this.disposed) return false;
    const outputSeq = this.outputSeq;
    this.terminal.write("", () => {
      if (this.disposed) return;
      onSnapshot({
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        data: this.serializeAddon.serialize(),
        outputSeq,
      });
    });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }
}
