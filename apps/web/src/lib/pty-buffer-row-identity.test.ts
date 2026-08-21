import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { attachPtyBufferRowIdentityTracker } from "./pty-buffer-row-identity";

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function fillScrollback(terminal: Terminal): Promise<void> {
  await write(terminal, "0\r\n1\r\n2\r\n3\r\n4\r\n5");
  expect(terminal.buffer.normal.length).toBe(6);
  expect(terminal.buffer.normal.baseY).toBe(3);
}

function createTerminal(): Terminal {
  return new Terminal({
    allowProposedApi: true,
    cols: 10,
    rows: 3,
    scrollback: 3,
  });
}

function readViewportLines(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) =>
    (buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").trimEnd(),
  );
}

function registerMarkerAtRow(terminal: Terminal, row: number) {
  const buffer = terminal.buffer.active;
  return terminal.registerMarker(row - (buffer.baseY + buffer.cursorY));
}

describe("xterm native scrolled-away output contract", () => {
  it("keeps viewportY and the painted history rows stable while the buffer can still grow", async () => {
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 10,
      rows: 3,
      scrollback: 10,
    });
    try {
      await write(terminal, "0\r\n1\r\n2\r\n3\r\n4\r\n5");
      terminal.scrollToLine(1);

      expect(terminal.buffer.normal.viewportY).toBe(1);
      expect(readViewportLines(terminal)).toEqual(["1", "2", "3"]);

      await write(terminal, "\r\n6\r\n7");

      expect(terminal.buffer.normal.baseY).toBe(5);
      expect(terminal.buffer.normal.viewportY).toBe(1);
      expect(readViewportLines(terminal)).toEqual(["1", "2", "3"]);
    } finally {
      terminal.dispose();
    }
  });

  it("rebases a scrolled-away viewport across full-scrollback trims until its oldest row expires", async () => {
    const terminal = createTerminal();
    try {
      await fillScrollback(terminal);
      terminal.scrollToLine(2);
      const firstVisible = registerMarkerAtRow(terminal, 2);
      expect(firstVisible).toBeDefined();
      expect(readViewportLines(terminal)).toEqual(["2", "3", "4"]);

      await write(terminal, "\r\n6");
      expect(terminal.buffer.normal.viewportY).toBe(1);
      expect(firstVisible?.line).toBe(1);
      expect(readViewportLines(terminal)).toEqual(["2", "3", "4"]);

      await write(terminal, "\r\n7");
      expect(terminal.buffer.normal.viewportY).toBe(0);
      expect(firstVisible?.line).toBe(0);
      expect(readViewportLines(terminal)).toEqual(["2", "3", "4"]);

      // Once the oldest visible row itself leaves the finite scrollback, no terminal can retain it.
      await write(terminal, "\r\n8");
      expect(firstVisible?.isDisposed).toBe(true);
      expect(terminal.buffer.normal.viewportY).toBe(0);
      expect(readViewportLines(terminal)).toEqual(["3", "4", "5"]);
    } finally {
      terminal.dispose();
    }
  });

  it("can scroll line by line through output received while away and re-engages the live tail", async () => {
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 10,
      rows: 3,
      scrollback: 10,
    });
    try {
      await write(terminal, "0\r\n1\r\n2\r\n3\r\n4\r\n5");
      terminal.scrollToLine(1);
      await write(terminal, "\r\n6\r\n7");

      expect(terminal.buffer.normal.viewportY).toBe(1);
      expect(terminal.buffer.normal.baseY).toBe(5);
      for (const expectedViewportY of [2, 3, 4, 5]) {
        terminal.scrollLines(1);
        expect(terminal.buffer.normal.viewportY).toBe(expectedViewportY);
      }
      expect(readViewportLines(terminal)).toEqual(["5", "6", "7"]);

      // At the tail xterm clears its native user-scrolling latch, so later output follows live.
      await write(terminal, "\r\n8");
      expect(terminal.buffer.normal.baseY).toBe(6);
      expect(terminal.buffer.normal.viewportY).toBe(6);
      expect(readViewportLines(terminal)).toEqual(["6", "7", "8"]);
    } finally {
      terminal.dispose();
    }
  });
});

describe("pty buffer row identity tracker", () => {
  it("tracks trims while viewportY is clamped at the top of scrollback", async () => {
    const terminal = createTerminal();
    try {
      await fillScrollback(terminal);
      terminal.scrollToTop();
      expect(terminal.buffer.normal.viewportY).toBe(0);

      const tracker = attachPtyBufferRowIdentityTracker(terminal);
      try {
        await write(terminal, "\r\n6\r\n7\r\n8");

        expect(terminal.buffer.normal.viewportY).toBe(0);
        expect(terminal.buffer.normal.baseY).toBe(3);
        expect(terminal.buffer.normal.length).toBe(6);
        expect(tracker.getOffset()).toBe(-3);
      } finally {
        tracker.dispose();
      }
    } finally {
      terminal.dispose();
    }
  });

  it("does not mistake CSI 2J marker disposal for a trim and resumes tracking", async () => {
    const terminal = createTerminal();
    try {
      await fillScrollback(terminal);
      terminal.scrollToTop();
      const tracker = attachPtyBufferRowIdentityTracker(terminal);
      try {
        const originalMarker = terminal.markers[0];
        await write(terminal, "\x1b[2J");

        expect(originalMarker.isDisposed).toBe(true);
        expect(terminal.buffer.normal.length).toBe(6);
        expect(terminal.buffer.normal.baseY).toBe(3);
        expect(tracker.getOffset()).toBe(0);

        await write(terminal, "\r\nnext");
        expect(tracker.getOffset()).toBe(-1);
      } finally {
        tracker.dispose();
      }
    } finally {
      terminal.dispose();
    }
  });

  it("does not report Terminal.clear as a trim and reanchors in the new buffer", async () => {
    const terminal = createTerminal();
    try {
      await fillScrollback(terminal);
      terminal.scrollToTop();
      const tracker = attachPtyBufferRowIdentityTracker(terminal);
      try {
        terminal.clear();

        expect(terminal.buffer.normal.length).toBe(3);
        expect(terminal.buffer.normal.baseY).toBe(0);
        expect(tracker.getOffset()).toBe(0);

        await fillScrollback(terminal);
        expect(tracker.getOffset()).toBe(0);
        await write(terminal, "\r\ntrimmed");
        expect(tracker.getOffset()).toBe(-1);
      } finally {
        tracker.dispose();
      }
    } finally {
      terminal.dispose();
    }
  });

  it("tracks CSI 3J because length, baseY, and the live marker prove a leading trim", async () => {
    const terminal = createTerminal();
    try {
      await fillScrollback(terminal);
      terminal.scrollToTop();
      const tracker = attachPtyBufferRowIdentityTracker(terminal);
      try {
        await write(terminal, "\x1b[3J");

        expect(terminal.buffer.normal.length).toBe(3);
        expect(terminal.buffer.normal.baseY).toBe(0);
        expect(tracker.getOffset()).toBe(-3);
      } finally {
        tracker.dispose();
      }
    } finally {
      terminal.dispose();
    }
  });

  it("detects a synchronous scrollback-capacity trim at the next read", async () => {
    const terminal = createTerminal();
    try {
      await fillScrollback(terminal);
      terminal.scrollToTop();
      const tracker = attachPtyBufferRowIdentityTracker(terminal);
      try {
        terminal.options.scrollback = 1;

        expect(terminal.buffer.normal.length).toBe(4);
        expect(terminal.buffer.normal.baseY).toBe(1);
        expect(tracker.getOffset()).toBe(-2);
      } finally {
        tracker.dispose();
      }
    } finally {
      terminal.dispose();
    }
  });

  it("starts a new baseline after resize reflow instead of calling merged rows a trim", async () => {
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 5,
      rows: 3,
      scrollback: 10,
    });
    try {
      await write(terminal, "0123456789ABCDEFGHIJKLMNO\r\nX");
      expect(terminal.buffer.normal.length).toBe(6);
      expect(terminal.buffer.normal.baseY).toBe(3);
      const tracker = attachPtyBufferRowIdentityTracker(terminal);
      try {
        terminal.resize(10, 3);

        expect(terminal.buffer.normal.length).toBe(4);
        expect(terminal.buffer.normal.baseY).toBe(1);
        expect(tracker.getOffset()).toBe(0);
      } finally {
        tracker.dispose();
      }
    } finally {
      terminal.dispose();
    }
  });

  it("ignores alternate-buffer scrolling and continues normal-buffer tracking after return", async () => {
    const terminal = createTerminal();
    try {
      await fillScrollback(terminal);
      terminal.scrollToTop();
      const tracker = attachPtyBufferRowIdentityTracker(terminal);
      try {
        await write(terminal, "\x1b[?1049h");
        expect(terminal.buffer.active.type).toBe("alternate");
        await write(terminal, "a\r\nb\r\nc\r\nd\r\ne\r\nf");
        expect(tracker.getOffset()).toBe(0);

        await write(terminal, "\x1b[?1049l");
        expect(terminal.buffer.active.type).toBe("normal");
        expect(tracker.getOffset()).toBe(0);
        await write(terminal, "\r\nnormal");
        expect(tracker.getOffset()).toBe(-1);
      } finally {
        tracker.dispose();
      }
    } finally {
      terminal.dispose();
    }
  });

  it("waits to create its normal-buffer marker when attached in the alternate buffer", async () => {
    const terminal = createTerminal();
    try {
      await write(terminal, "\x1b[?1049h");
      const tracker = attachPtyBufferRowIdentityTracker(terminal);
      try {
        expect(terminal.buffer.active.type).toBe("alternate");
        expect(terminal.markers).toHaveLength(0);
        await write(terminal, "a\r\nb\r\nc\r\nd");
        expect(tracker.getOffset()).toBe(0);

        await write(terminal, "\x1b[?1049l");
        expect(terminal.buffer.active.type).toBe("normal");
        expect(terminal.markers).toHaveLength(1);
        expect(tracker.getOffset()).toBe(0);
      } finally {
        tracker.dispose();
      }
    } finally {
      terminal.dispose();
    }
  });

  it("treats an explicit marker disposal as invalidation, not row movement", async () => {
    const terminal = createTerminal();
    try {
      await fillScrollback(terminal);
      terminal.scrollToTop();
      const tracker = attachPtyBufferRowIdentityTracker(terminal);
      try {
        terminal.markers[0]?.dispose();

        expect(tracker.getOffset()).toBe(0);
        expect(terminal.markers).toHaveLength(1);
        await write(terminal, "\r\ntrimmed");
        expect(tracker.getOffset()).toBe(-1);
      } finally {
        tracker.dispose();
      }
    } finally {
      terminal.dispose();
    }
  });

  it("removes its marker and event effects on cleanup", async () => {
    const terminal = createTerminal();
    try {
      await fillScrollback(terminal);
      terminal.scrollToTop();
      const tracker = attachPtyBufferRowIdentityTracker(terminal);

      expect(terminal.markers).toHaveLength(1);
      tracker.dispose();
      tracker.dispose();
      expect(terminal.markers).toHaveLength(0);

      await write(terminal, "\r\ntrimmed");
      expect(tracker.getOffset()).toBe(0);
      expect(terminal.markers).toHaveLength(0);
    } finally {
      terminal.dispose();
    }
  });
});
