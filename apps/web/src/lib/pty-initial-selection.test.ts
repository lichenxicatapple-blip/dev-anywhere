import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { resolveTerminalInitialRangeAtBufferPoint } from "./pty-line-selection";

let terminal: Terminal | undefined;
afterEach(() => terminal?.dispose());

async function writeTerminal(text: string, cols = 120): Promise<Terminal> {
  terminal = new Terminal({ cols, rows: 12, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal!.write(text, resolve));
  return terminal;
}

describe("PTY initial URL selection", () => {
  it.each([
    "x.com?user=cat",
    "x.com/profile?user=cat&mode=full#about",
    "x.com/report.md?download=cat.txt",
    "https://x.com?user=cat",
    "https://example.com/report.md?user=cat&next=%2Fa%3Fb%3D1#results",
    "http://localhost:5174/path?user=cat&empty=&enabled#section",
    "http://127.0.0.1:3101/?user=cat",
    "https://[::1]:5174/path?user=cat",
    "example.com:8080/path?user=cat",
    "https://example.com/a_(b)?user=cat&items[]=1#section",
    "ftp://cat:example@example.com:2121/pub/report.txt;type=i",
    "ftps://example.com/pub/cat.tar.gz",
    "sftp://cat@server:2222/home/cat/report.tar.gz",
    "ssh://cat@server:22",
    "git+ssh://cat@server/project.git",
    "file:///C:/Users/cat/report.txt",
    "wss://localhost:3101/client?user=cat",
  ])("selects all of %s when pressing its host or parameters", async (url) => {
    const text = `open (${url}), then continue`;
    const term = await writeTerminal(text, 200);
    for (const offset of [1, url.indexOf("?"), url.indexOf("cat"), url.length - 1].filter(
      (value) => value >= 0,
    )) {
      const selected = resolveTerminalInitialRangeAtBufferPoint({
        terminal: term,
        point: { row: 0, column: 6 + offset },
      });
      expect(selected?.text).toBe(url);
      expect(selected?.pathAction).toBeUndefined();
    }
  });

  it("extends a URL across soft wraps, including a percent-encoded query", async () => {
    const url = "https://example.com/path?user=cat&next=%2Fa%3Fb%3D1#section";
    const term = await writeTerminal(`URL ${url} end`, 24);
    expect(
      resolveTerminalInitialRangeAtBufferPoint({ terminal: term, point: { row: 1, column: 8 } }),
    ).toMatchObject({ anchor: { row: 0, column: 4 }, focus: { row: 2, column: 14 }, text: url });
  });

  it("maps a URL after wide characters to the correct terminal columns", async () => {
    const url = "x.com?user=cat";
    const term = await writeTerminal(`网址：${url}。继续`);
    expect(
      resolveTerminalInitialRangeAtBufferPoint({ terminal: term, point: { row: 0, column: 8 } }),
    ).toMatchObject({ anchor: { row: 0, column: 6 }, focus: { row: 0, column: 19 }, text: url });
  });

  it("includes a fragment directly after a bare domain without taking surrounding punctuation", async () => {
    const term = await writeTerminal("See [x.com#about], then continue.");
    expect(
      resolveTerminalInitialRangeAtBufferPoint({ terminal: term, point: { row: 0, column: 11 } })
        ?.text,
    ).toBe("x.com#about");
  });

  it("does not extend a URL across a hard newline", async () => {
    const term = await writeTerminal("https://x.com?user=cat\r\nnext=value");
    expect(
      resolveTerminalInitialRangeAtBufferPoint({ terminal: term, point: { row: 0, column: 10 } })
        ?.text,
    ).toBe("https://x.com?user=cat");
  });

  it.each([
    ["ordinary words", 2, "ordinary"],
    ["中文 世界", 1, "中文"],
    ["ready?next=value", 2, "ready"],
    ["package.json other", 2, "package.json"],
    ["./src/example.com other", 4, "./src/example.com"],
    ["git@github.com:org/repo.git other", 8, "git@github.com:org/repo.git"],
  ])("keeps the existing word/path boundary in %s", async (text, column, expected) => {
    const term = await writeTerminal(text);
    expect(
      resolveTerminalInitialRangeAtBufferPoint({ terminal: term, point: { row: 0, column } })?.text,
    ).toBe(expected);
  });
});
