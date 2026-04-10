import pkg from "@xterm/headless";
const { Terminal } = pkg;
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const raw = readFileSync(join(__dirname, "fixtures/claude-session.raw"), "utf-8");
const term = new Terminal({ cols: 120, rows: 40, scrollback: 10000, allowProposedApi: true });

function run() {
  term.write(raw, () => {
    const buf = term.buffer.active;
    console.log("=== Terminal State ===");
    console.log("Total lines:", buf.length);
    console.log("Viewport rows:", term.rows);
    console.log("Scrollback lines:", buf.length - term.rows);
    console.log("");

    console.log("=== First 20 lines (scrollback top) ===");
    for (let y = 0; y < Math.min(20, buf.length); y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      let text = "";
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell) continue;
        text += cell.getChars() || " ";
      }
      console.log(y.toString().padStart(4) + " |" + text.trimEnd());
    }

    console.log("");
    console.log("=== Last 30 lines (viewport area) ===");
    for (let y = Math.max(0, buf.length - 30); y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      let text = "";
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell) continue;
        text += cell.getChars() || " ";
      }
      console.log(y.toString().padStart(4) + " |" + text.trimEnd());
    }

    // TermSpan 结构示例：取前 3 个非空行
    console.log("");
    console.log("=== TermSpan structure (first 3 non-empty lines) ===");
    let count = 0;
    for (let y = 0; y < buf.length && count < 3; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      let hasContent = false;
      for (let x = 0; x < line.length; x++) {
        const ch = line.getCell(x)?.getChars();
        if (ch && ch.trim()) { hasContent = true; break; }
      }
      if (!hasContent) continue;

      const spans: Array<{ text: string; fg: string | null; bold: boolean }> = [];
      let cur: { text: string; fg: string | null; bold: boolean } | null = null;
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        const fgDef = cell.isFgDefault();
        const fg = fgDef ? null : "#" + cell.getFgColor().toString(16).padStart(6, "0");
        const bold = Boolean(cell.isBold());

        if (cur && cur.fg === fg && cur.bold === bold) {
          cur.text += chars;
        } else {
          if (cur) spans.push(cur);
          cur = { text: chars, fg, bold };
        }
      }
      if (cur) spans.push(cur);
      console.log(`Line ${y}:`, JSON.stringify(spans.slice(0, 8)));
      count++;
    }

    term.dispose();
  });
}

run();
