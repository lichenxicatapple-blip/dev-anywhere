import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { observePtyCursorFollowTarget } from "./pty-cursor-follow-target";

const disposables: Array<{ dispose(): void }> = [];

function createTerminal() {
  const term = new Terminal({ cols: 80, rows: 29, allowProposedApi: true });
  const target = observePtyCursorFollowTarget(term);
  disposables.push(term, target);
  return {
    term,
    target,
    write: (data: string) => new Promise<void>((resolve) => term.write(data, resolve)),
  };
}

afterEach(() => {
  for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
});

describe("PTY cursor follow target (real xterm parser)", () => {
  it("keeps ordinary Shell typing and cursor movement eligible", async () => {
    const { target, write } = createTerminal();
    await write("x".repeat(65));
    expect(target.canFollow()).toBe(true);
    await write("\r\nnext prompt> ");
    expect(target.canFollow()).toBe(true);
    await write("\x1b[60G\x1b[10D");
    expect(target.canFollow()).toBe(true);
  });

  it("ignores a hidden paint position until the input column is restored", async () => {
    const { term, target, write } = createTerminal();
    await write("\x1b[?25l\x1b[26;6H");
    expect(target.canFollow()).toBe(true);
    await write(`\x1b[?2026h\x1b[24;1H${"-".repeat(79)}`);
    expect(target.canFollow()).toBe(false);
    await write("\x1b[?2026l");
    expect(term.buffer.active.cursorX).toBe(79);
    expect(target.canFollow()).toBe(false);
    await write("\x1b[2B");
    expect(target.canFollow()).toBe(false);
    await write("\x1b[6G\x1b[?25l");
    expect(term.buffer.active.cursorX).toBe(5);
    expect(target.canFollow()).toBe(true);
  });

  it.each([false, true])(
    "accepts a software caret inside synchronized output: %s",
    async (inside) => {
      const { target, write } = createTerminal();
      const position = "\x1b[26;61H";
      await write(
        `\x1b[?25l\x1b[?2026h${"x".repeat(79)}${inside ? position : ""}\x1b[?2026l${inside ? "" : position}`,
      );
      expect(target.canFollow()).toBe(true);
    },
  );

  it.each(["\x1b[61G", "\x1b[61`", "\x1b[4;61H", "\x1b[4;61f", "\x1b[60C", "\x1b[60a"])(
    "accepts the explicitly positioned hidden column: %j",
    async (sequence) => {
      const { term, target, write } = createTerminal();
      await write(`\x1b[?25l${sequence}`);
      expect(term.buffer.active.cursorX).toBe(60);
      expect(target.canFollow()).toBe(true);
      await write("x");
      expect(target.canFollow()).toBe(false);
      await write("\x1b[10D");
      expect(target.canFollow()).toBe(true);
    },
  );

  it("uses xterm visibility after reset and never consumes terminal commands", async () => {
    const { term, target, write } = createTerminal();
    await write("\x1b[?25lhidden paint");
    expect(target.canFollow()).toBe(false);
    term.reset();
    target.reset();
    // Direct Terminal.reset preserves xterm 6's cursor visibility flag.
    await write("still hidden");
    expect(target.canFollow()).toBe(false);
    await write("\x1b[?25hvisible input");
    expect(target.canFollow()).toBe(true);
    await write("\x1b[?25l\x1b[999G");
    expect(term.buffer.active.cursorX).toBe(79);
    expect(target.canFollow()).toBe(true);
    await write("\x1b[G");
    expect(term.buffer.active.cursorX).toBe(0);
    expect(target.canFollow()).toBe(true);
  });
});
