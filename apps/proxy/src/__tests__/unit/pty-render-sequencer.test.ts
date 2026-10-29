import { describe, expect, it, vi } from "vitest";
import { PtyRenderSequencer, type PtySnapshot } from "#src/common/pty-render-sequencer.js";

function snapshot(sequencer: PtyRenderSequencer): Promise<PtySnapshot> {
  return new Promise((resolve, reject) => {
    if (!sequencer.captureSnapshot(resolve)) reject(new Error("sequencer is disposed"));
  });
}

describe("PtyRenderSequencer", () => {
  it("answers hosted default-color queries locally once across chunk boundaries", async () => {
    const replies: string[] = [];
    const sequencer = new PtyRenderSequencer({
      cols: 80,
      rows: 24,
      onDefaultColorResponse: (data) => replies.push(data),
    });
    try {
      for (const chunk of ["before\x1b", "]10;", "?\x1b", "\\\x1b]11;?", "\x07after"]) {
        sequencer.write(chunk);
      }
      const first = await snapshot(sequencer);
      expect(replies).toEqual([
        "\x1b]10;rgb:d4d4/d4d4/d4d4\x1b\\",
        "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
      ]);
      expect(first.data).toContain("beforeafter");
      await snapshot(sequencer);
      expect(replies).toHaveLength(2);
      // No other terminal reports are forwarded through this local-response callback.
      sequencer.write("\x1b[6n\x1b[c\x1b]12;?\x07\x1b]4;1;?\x07");
      await snapshot(sequencer);
      expect(replies).toHaveLength(2);
    } finally {
      sequencer.dispose();
    }
  });

  it("reports current OSC colors and restores the shared defaults after reset", async () => {
    const replies: string[] = [];
    const sequencer = new PtyRenderSequencer({
      cols: 80,
      rows: 24,
      onDefaultColorResponse: (data) => replies.push(data),
    });
    try {
      sequencer.write("\x1b]10;#ffcc00;rgb:1/2/3\x07\x1b]10;?\x07\x1b]11;?\x07");
      sequencer.write("\x1b]11;not-a-color\x07\x1b]11;?\x07");
      sequencer.write("\x1b]110\x07\x1b]111\x1b\\\x1b]10;?\x07\x1b]11;?\x07");
      await snapshot(sequencer);
      expect(replies).toEqual([
        "\x1b]10;rgb:ffff/cccc/0000\x1b\\",
        "\x1b]11;rgb:1111/2222/3333\x1b\\",
        "\x1b]11;rgb:1111/2222/3333\x1b\\",
        "\x1b]10;rgb:d4d4/d4d4/d4d4\x1b\\",
        "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
      ]);
    } finally {
      sequencer.dispose();
    }
  });

  it("orders write -> snapshot -> resize -> write without leaking later state into the snapshot", async () => {
    const sequencer = new PtyRenderSequencer({ cols: 80, rows: 24 });

    try {
      expect(sequencer.write("before-barrier\r\n")).toBe(1);
      const beforeResize = snapshot(sequencer);
      expect(sequencer.resize(120, 40)).toBe(2);
      expect(sequencer.write("after-resize\r\n")).toBe(3);

      const snapshotBeforeResize = await beforeResize;
      expect(snapshotBeforeResize).toMatchObject({
        cols: 80,
        rows: 24,
        outputSeq: 1,
      });
      expect(snapshotBeforeResize.data).toContain("before-barrier");
      expect(snapshotBeforeResize.data).not.toContain("after-resize");
      const afterResize = await snapshot(sequencer);
      expect(afterResize).toMatchObject({ cols: 120, rows: 40, outputSeq: 3 });
      expect(afterResize.data).toContain("before-barrier");
      expect(afterResize.data).toContain("after-resize");
    } finally {
      sequencer.dispose();
    }
  });

  it("keeps snapshot-before-resize on the old geometry and watermark", async () => {
    const sequencer = new PtyRenderSequencer({ cols: 80, rows: 24 });

    try {
      expect(sequencer.write("one")).toBe(1);
      const pendingSnapshot = snapshot(sequencer);
      expect(sequencer.resize(100, 30)).toBe(2);

      await expect(pendingSnapshot).resolves.toMatchObject({
        cols: 80,
        rows: 24,
        outputSeq: 1,
      });
    } finally {
      sequencer.dispose();
    }
  });

  it("keeps resize-before-snapshot on the new geometry and watermark", async () => {
    const sequencer = new PtyRenderSequencer({ cols: 80, rows: 24 });

    try {
      expect(sequencer.write("one")).toBe(1);
      expect(sequencer.resize(100, 30)).toBe(2);

      await expect(snapshot(sequencer)).resolves.toMatchObject({
        cols: 100,
        rows: 30,
        outputSeq: 2,
      });
    } finally {
      sequencer.dispose();
    }
  });

  it("does not allocate render sequence numbers for empty writes or snapshots", async () => {
    const sequencer = new PtyRenderSequencer({ cols: 80, rows: 24 });

    try {
      expect(sequencer.write("")).toBeNull();
      await expect(snapshot(sequencer)).resolves.toMatchObject({ outputSeq: 0 });
      await expect(snapshot(sequencer)).resolves.toMatchObject({ outputSeq: 0 });
      expect(sequencer.write("first event")).toBe(1);
    } finally {
      sequencer.dispose();
    }
  });

  it("keeps consecutive writes and resizes in one monotonic render sequence", async () => {
    const sequencer = new PtyRenderSequencer({ cols: 80, rows: 24 });

    try {
      expect(sequencer.write("portrait-before\r\n")).toBe(1);
      expect(sequencer.resize(120, 40)).toBe(2);
      expect(sequencer.write("landscape-middle\r\n")).toBe(3);
      expect(sequencer.resize(90, 32)).toBe(4);
      expect(sequencer.write("portrait-after\r\n")).toBe(5);

      const finalSnapshot = await snapshot(sequencer);
      expect(finalSnapshot).toMatchObject({ cols: 90, rows: 32, outputSeq: 5 });
      expect(finalSnapshot.data).toContain("portrait-before");
      expect(finalSnapshot.data).toContain("landscape-middle");
      expect(finalSnapshot.data).toContain("portrait-after");
    } finally {
      sequencer.dispose();
    }
  });

  it("invalidates pending callbacks and future operations when disposed", async () => {
    const sequencer = new PtyRenderSequencer({ cols: 80, rows: 24 });
    const onSnapshot = vi.fn();

    expect(sequencer.write("queued")).toBe(1);
    expect(sequencer.captureSnapshot(onSnapshot)).toBe(true);
    expect(sequencer.resize(100, 30)).toBe(2);
    sequencer.dispose();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(sequencer.write("late")).toBeNull();
    expect(sequencer.resize(120, 40)).toBeNull();
    expect(sequencer.captureSnapshot(onSnapshot)).toBe(false);
  });
});
