// @vitest-environment node

import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { Terminal } from "@xterm/xterm";
import { build, resolveConfig } from "vite";
import { expect, it } from "vitest";

it("keeps parsing Vim output after mode queries in the production-minified terminal", async () => {
  // Development transforms do not exercise the minifier that previously removed a local
  // variable from xterm's DECRQM handler and stranded every subsequent terminal write.
  const entry = "virtual:xterm-production-regression";
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const productionConfig = await resolveConfig(
    { root, configFile: `${root}/vite.config.ts`, logLevel: "silent" },
    "build",
  );
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    esbuild: productionConfig.esbuild,
    plugins: [
      {
        name: "xterm-production-regression",
        resolveId: (id) => (id === entry ? `\0${entry}` : undefined),
        load: (id) =>
          id === `\0${entry}`
            ? 'import { Terminal } from "@xterm/xterm"; globalThis.PtyProductionTerminal = Terminal;'
            : undefined,
      },
    ],
    build: {
      write: false,
      target: productionConfig.build.target,
      minify: productionConfig.build.minify,
      modulePreload: false,
      rollupOptions: { input: entry },
    },
  });
  if (Array.isArray(result) || !("output" in result)) {
    throw new Error("Expected a single production bundle");
  }
  const chunk = result.output.find((output) => output.type === "chunk" && output.isEntry);
  if (!chunk || chunk.type !== "chunk") throw new Error("Missing production entry chunk");

  let rejectParserError!: (error: unknown) => void;
  const parserError = new Promise<never>((_, reject) => {
    rejectParserError = reject;
  });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const context = {
    PtyProductionTerminal: undefined as typeof Terminal | undefined,
    process,
    console,
    queueMicrotask,
    performance,
    setTimeout: (callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        try {
          callback();
        } catch (error) {
          rejectParserError(error);
        }
      }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout,
  };
  runInNewContext(chunk.code, context);
  if (!context.PtyProductionTerminal) throw new Error("Missing bundled Terminal constructor");
  const terminal = new context.PtyProductionTerminal({
    cols: 175,
    rows: 43,
    scrollback: 5000,
    allowProposedApi: true,
  });
  const responses: string[] = [];
  terminal.onData((data) => responses.push(data));
  const write = (data: string) =>
    Promise.race([new Promise<void>((resolve) => terminal.write(data, resolve)), parserError]);

  try {
    await write(Array.from({ length: 1500 }, (_, row) => `history ${row}\r\n`).join(""));
    expect(terminal.buffer.normal.baseY).toBeGreaterThan(1000);

    // Vim queries cursor blinking on startup. Exercise additional mode-query branches too,
    // then verify the same parser can finish later writes instead of freezing on the query.
    await write("\x1b[?1049h\x1b[?12$p\x1b[?25$p\x1b[?2004$p\x1b[?2026$p");
    expect(responses).toEqual(["\x1b[?12;2$y", "\x1b[?25;1$y", "\x1b[?2004;2$y", "\x1b[?2026;2$y"]);

    await write("\x1b[2J\x1b[1;1HVIM-EDIT\x1b[43;1H:q");
    expect(terminal.buffer.active.type).toBe("alternate");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("VIM-EDIT");
    expect(terminal.buffer.active.getLine(42)?.translateToString(true)).toBe(":q");

    await write("\x1b[?1049l\r\nAFTER-VIM");
    expect(terminal.buffer.active.type).toBe("normal");
    const buffer = terminal.buffer.active;
    expect(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true)).toBe(
      "AFTER-VIM",
    );
  } finally {
    terminal.dispose();
    for (const timer of timers) clearTimeout(timer);
  }
}, 15_000);
