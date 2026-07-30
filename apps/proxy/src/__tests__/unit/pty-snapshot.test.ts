import { describe, expect, it } from "vitest";
import pkg from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { capturePtySnapshot, type PtySnapshot } from "#src/common/pty-snapshot.js";

const { Terminal: HeadlessTerminal } = pkg;

describe("PTY snapshot capture", () => {
  it("waits for queued output before serializing its sequence watermark", async () => {
    const terminal = new HeadlessTerminal({
      cols: 80,
      rows: 24,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);

    try {
      terminal.write("queued-before-snapshot\r\n");
      expect(serializer.serialize()).not.toContain("queued-before-snapshot");

      const snapshot = await new Promise<PtySnapshot>((resolve) => {
        capturePtySnapshot(terminal, serializer, 1, resolve);
      });

      expect(snapshot.outputSeq).toBe(1);
      expect(snapshot.data).toContain("queued-before-snapshot");
    } finally {
      terminal.dispose();
    }
  });

  it("does not include output queued after the snapshot barrier", async () => {
    const terminal = new HeadlessTerminal({
      cols: 80,
      rows: 24,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);

    try {
      terminal.write("before-barrier\r\n");
      const snapshotPromise = new Promise<PtySnapshot>((resolve) => {
        capturePtySnapshot(terminal, serializer, 7, resolve);
      });
      terminal.write("after-barrier\r\n");

      const snapshot = await snapshotPromise;
      expect(snapshot.outputSeq).toBe(7);
      expect(snapshot.data).toContain("before-barrier");
      expect(snapshot.data).not.toContain("after-barrier");
    } finally {
      terminal.dispose();
    }
  });
});
