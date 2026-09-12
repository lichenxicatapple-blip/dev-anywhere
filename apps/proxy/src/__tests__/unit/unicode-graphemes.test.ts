import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const addonSource = readFileSync(require.resolve("@xterm/addon-unicode-graphemes"), "utf8");

describe("Unicode grapheme data in Node buffers", () => {
  it.each([0, 1, 8, 256, 4096])("renders correctly with data at byte offset %i", async (offset) => {
    const module = { exports: {} as Record<string, unknown> };
    const decodedOffsets: number[] = [];
    // Node may decode base64 into a shared pool. Keep its preceding bytes invalid
    // so this fails deterministically if the dependency ignores the view's offset.
    runInNewContext(addonSource, {
      exports: module.exports,
      module,
      Buffer: {
        from(value: string, encoding: BufferEncoding) {
          const decoded = Buffer.from(value, encoding);
          const storage = new Uint8Array(offset + decoded.length);
          storage.set(decoded, offset);
          const view = storage.subarray(offset);
          decodedOffsets.push(view.byteOffset);
          return view;
        },
      },
    });
    expect(decodedOffsets).toEqual([offset]);

    const Addon = module.exports.UnicodeGraphemesAddon as new () => {
      activate(terminal: Terminal): void;
      dispose(): void;
    };
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      terminal.loadAddon(new Addon());
      terminal.unicode.activeVersion = "15-graphemes";
      for (const [text, width] of [
        ["abc", 3],
        ["中文", 4],
        ["e\u0301", 1],
        ["👨‍👩‍👧", 2],
        ["👍🏽", 2],
        ["🇨🇳", 2],
      ] as const) {
        await new Promise<void>((resolve) => terminal.write(`\r\u001b[2K${text}`, resolve));
        expect(terminal.buffer.active.cursorX, text).toBe(width);
        expect(terminal.buffer.active.getLine(0)?.translateToString(true), text).toBe(text);
      }
    } finally {
      terminal.dispose();
    }
  });
});
