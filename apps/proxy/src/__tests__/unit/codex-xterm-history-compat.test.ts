import { describe, expect, it } from "vitest";
import pkg from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  CodexXtermHistoryCompat,
  createCodexXtermHistoryCompat,
} from "#src/common/codex-xterm-history-compat.js";

const { Terminal: HeadlessTerminal } = pkg;
const ESC = "\x1b";

function historyInsert(bottom: number, count: number): string {
  const repaintRow = bottom - count + 1;
  return `${ESC}[?2026h${ESC}[1;${bottom}r${ESC}[${count}S${ESC}[r${ESC}[${repaintRow};1H${ESC}[J${ESC}[?2026l`;
}

function transformByChunks(input: string, splitAt: number[], rows = 24): string {
  const compat = new CodexXtermHistoryCompat(rows);
  let output = "";
  let offset = 0;
  for (const end of splitAt) {
    output += compat.push(input.slice(offset, end));
    offset = end;
  }
  output += compat.push(input.slice(offset));
  output += compat.flush();
  return output;
}

async function settleTerminal(terminal: InstanceType<typeof HeadlessTerminal>): Promise<void> {
  await new Promise<void>((resolve) => terminal.write("", resolve));
}

describe("Codex xterm history compatibility", () => {
  it("rewrites the exact synchronized Codex history-insert transaction", () => {
    const compat = new CodexXtermHistoryCompat(37);
    const input = `before${historyInsert(28, 2)}after`;
    const output = compat.push(input);

    expect(output).toBe(
      `before${ESC}[?2026h${ESC}[r${ESC}[999;1H\n\n${ESC}[H${ESC}[27;1H${ESC}[J${ESC}[?2026lafter`,
    );
    expect(compat.stats).toEqual({ rewrittenTransactions: 1, preservedRows: 2 });
  });

  it("produces the same output across every possible chunk boundary", () => {
    const input = `prefix${historyInsert(20, 3)}suffix`;
    const expected = transformByChunks(input, [], 30);

    for (let split = 0; split <= input.length; split += 1) {
      expect(transformByChunks(input, [split], 30)).toBe(expected);
    }
    expect(
      transformByChunks(
        input,
        Array.from({ length: input.length }, (_, index) => index + 1),
        30,
      ),
    ).toBe(expected);
  });

  it("passes near misses, full-screen regions, and alternate-screen output through unchanged", () => {
    const cases = [
      `${ESC}[?2026h${ESC}[2;20r${ESC}[1S${ESC}[r${ESC}[20;1H${ESC}[J${ESC}[?2026l`,
      historyInsert(24, 1),
      `${ESC}[?2026h${ESC}[1;20r${ESC}[2S${ESC}[r${ESC}[20;1H${ESC}[J${ESC}[?2026l`,
      `${ESC}[?1049h${historyInsert(20, 1)}${ESC}[?1049l`,
    ];

    for (const input of cases) {
      const compat = new CodexXtermHistoryCompat(24);
      expect(compat.push(input) + compat.flush()).toBe(input);
      expect(compat.stats.rewrittenTransactions).toBe(0);
    }
  });

  it("flushes an incomplete synchronized block byte-for-byte", () => {
    const compat = new CodexXtermHistoryCompat(37);
    const input = `${ESC}[?2026h${ESC}[1;30r${ESC}[1S`;

    expect(compat.push(input)).toBe("");
    expect(compat.flush()).toBe(input);
  });

  it("is enabled only for Codex and supports an emergency off switch", () => {
    expect(createCodexXtermHistoryCompat("claude", 24, {})).toBeNull();
    expect(createCodexXtermHistoryCompat("codex", 24, {})).toBeInstanceOf(CodexXtermHistoryCompat);
    expect(
      createCodexXtermHistoryCompat("codex", 24, {
        DEV_ANYWHERE_CODEX_XTERM_HISTORY_COMPAT: "0",
      }),
    ).toBeNull();
  });

  it("preserves scrolled history while keeping the final visible screen identical", async () => {
    const createTerminal = () => {
      const terminal = new HeadlessTerminal({
        cols: 40,
        rows: 12,
        scrollback: 100,
        allowProposedApi: true,
      });
      const serializer = new SerializeAddon();
      terminal.loadAddon(serializer);
      return { terminal, serializer };
    };
    const original = createTerminal();
    const fixed = createTerminal();
    const seed = Array.from(
      { length: 20 },
      (_, index) => `LINE-${String(index + 1).padStart(2, "0")}\r\n`,
    ).join("");
    const transaction = historyInsert(8, 3);
    const compat = new CodexXtermHistoryCompat(12);

    original.terminal.write(seed + transaction);
    fixed.terminal.write(seed + compat.push(transaction) + compat.flush());
    await Promise.all([settleTerminal(original.terminal), settleTerminal(fixed.terminal)]);

    const visibleText = (terminal: InstanceType<typeof HeadlessTerminal>) => {
      const buffer = terminal.buffer.active;
      return Array.from({ length: terminal.rows }, (_, row) =>
        buffer.getLine(buffer.baseY + row)?.translateToString(true),
      );
    };
    expect(visibleText(fixed.terminal)).toEqual(visibleText(original.terminal));
    expect(fixed.terminal.buffer.normal.length - original.terminal.buffer.normal.length).toBe(3);
    expect(fixed.serializer.serialize()).toContain("LINE-12");
    expect(original.serializer.serialize()).not.toContain("LINE-12");

    original.terminal.dispose();
    fixed.terminal.dispose();
  });
});
