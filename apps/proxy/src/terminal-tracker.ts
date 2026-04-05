import pkg from "@xterm/headless";
const { Terminal } = pkg;
import serializePkg from "@xterm/addon-serialize";
const { SerializeAddon } = serializePkg;
import { EventStore, encodeSizePayload } from "./event-store.js";
import { writeFileSync } from "node:fs";

const SNAPSHOT_EVENT_THRESHOLD = 100;

export class TerminalTracker {
  private readonly terminal: Terminal;
  private readonly serialize: SerializeAddon;
  private readonly store: EventStore;
  private readonly snapshotPath: string;
  private eventsSinceSnapshot: number = 0;

  constructor(store: EventStore, snapshotPath: string, cols = 120, rows = 40) {
    this.store = store;
    this.snapshotPath = snapshotPath;
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 1000,
      allowProposedApi: true,
    });
    this.serialize = new SerializeAddon();
    this.terminal.loadAddon(this.serialize);
  }

  feed(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write(data, () => {
        this.eventsSinceSnapshot++;
        resolve();
      });
    });
  }

  shouldSnapshot(): boolean {
    return this.eventsSinceSnapshot >= SNAPSHOT_EVENT_THRESHOLD;
  }

  takeSnapshot(): void {
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    const serialized = this.serialize.serialize({ scrollback: 0 });
    const content = Buffer.from(serialized, "utf-8");
    // payload 格式：[4 字节 cols+rows][序列化内容]
    const sizeHeader = encodeSizePayload(cols, rows);
    const payload = Buffer.concat([sizeHeader, content]);

    this.store.writeSnapshot(payload);
    writeFileSync(this.snapshotPath, payload);

    this.eventsSinceSnapshot = 0;
  }

  onStateChange(from: string, to: string): void {
    if (from === "working" && to === "idle") {
      this.takeSnapshot();
    }
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
