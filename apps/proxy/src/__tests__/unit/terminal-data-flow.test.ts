import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";

// headless terminal 的 write 是异步的，需要等待回调
function termWrite(terminal: InstanceType<typeof HeadlessTerminal>, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

/**
 * 终端数据流验证
 *
 * 验证 HeadlessTerminal + SerializeAddon 的核心能力：
 * write(data) -> serialize() 产出完整终端状态，用于远程 client 订阅时的快照
 */
describe("headless terminal write + serialize", () => {
  let terminal: InstanceType<typeof HeadlessTerminal>;
  let serializeAddon: SerializeAddon;

  beforeEach(() => {
    terminal = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);
  });

  afterEach(() => {
    terminal.dispose();
  });

  it("headless terminal accepts PTY data and serialize produces output", async () => {
    await termWrite(terminal, "$ npm test\r\nPASS all tests\r\n");

    const serialized = serializeAddon.serialize();
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized).toContain("npm test");
    expect(serialized).toContain("PASS all tests");
  });

  it("headless terminal preserves ANSI color sequences in serialize output", async () => {
    await termWrite(terminal, "\x1b[31mERROR\x1b[0m normal text\r\n");

    const serialized = serializeAddon.serialize();
    expect(serialized).toContain("ERROR");
    expect(serialized).toContain("normal text");
  });

  it("headless terminal handles wide characters (CJK)", async () => {
    await termWrite(terminal, "AB\u4e2d\u6587CD\r\n");

    const serialized = serializeAddon.serialize();
    expect(serialized).toContain("\u4e2d");
    expect(serialized).toContain("\u6587");
  });

  it("headless terminal resize updates columns and rows", async () => {
    await termWrite(terminal, "hello\r\n");
    terminal.resize(120, 40);
    await termWrite(terminal, "after resize\r\n");

    const serialized = serializeAddon.serialize();
    expect(serialized).toContain("hello");
    expect(serialized).toContain("after resize");
  });
});

describe("SeqCounter integration smoke test", () => {
  it("SeqCounter can be imported and used", async () => {
    const { SeqCounter } = await import("#src/common/seq-counter.js");
    const { mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    const tmpDir = join(process.cwd(), ".test-seq-counter");
    mkdirSync(tmpDir, { recursive: true });

    const counter = new SeqCounter("test-session", tmpDir);
    expect(counter.current()).toBe(0);
    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(2);

    const counter2 = new SeqCounter("test-session", tmpDir);
    expect(counter2.current()).toBe(2);
    expect(counter2.next()).toBe(3);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
