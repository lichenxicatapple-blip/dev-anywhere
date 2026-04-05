import pkg from "@xterm/headless";
const { Terminal } = pkg;
import serializePkg from "@xterm/addon-serialize";
const { SerializeAddon } = serializePkg;
import { EventStore } from "./event-store.js";
import { writeFileSync } from "node:fs";

const SNAPSHOT_EVENT_THRESHOLD = 100;

export class TerminalTracker {
  private readonly terminal: Terminal;
  private readonly serialize: SerializeAddon;
  private readonly store: EventStore;
  private readonly snapshotPath: string;
  private eventsSinceSnapshot: number = 0;

  constructor(store: EventStore, snapshotPath: string) {
    this.store = store;
    this.snapshotPath = snapshotPath;
    this.terminal = new Terminal({
      cols: 120,
      rows: 40,
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
    const serialized = this.serialize.serialize();
    const payload = Buffer.from(serialized, "utf-8");

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
