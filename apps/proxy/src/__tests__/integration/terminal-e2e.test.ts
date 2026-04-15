import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures");

// headless terminal 的 write 是异步的，需要等待回调
function termWrite(terminal: InstanceType<typeof HeadlessTerminal>, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

/**
 * 从 NDJSON fixture 文件加载录制的 PTY chunk
 */
function loadRecordedChunks(): Array<{ ts: number; data: string }> {
  const content = readFileSync(join(FIXTURES_DIR, "claude-chunks.ndjson"), "utf-8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record: { data?: string }) => record.data !== undefined);
}

// 批量写入 chunk 到 terminal
async function feedChunks(terminal: InstanceType<typeof HeadlessTerminal>, chunks: Array<{ data: string }>, count: number): Promise<void> {
  const n = Math.min(count, chunks.length);
  for (let i = 0; i < n; i++) {
    await termWrite(terminal, chunks[i].data);
  }
}

/**
 * 终端端到端集成测试（v2 pipeline）
 *
 * 使用录制的真实 PTY chunk 验证 @xterm/headless + @xterm/addon-serialize 链路
 */
describe("Terminal E2E with headless + serialize (v2 pipeline)", () => {
  let chunks: Array<{ ts: number; data: string }>;

  beforeEach(() => {
    chunks = loadRecordedChunks();
  });

  it("fixture has real PTY chunks with varying sizes", () => {
    expect(chunks.length).toBeGreaterThan(100);

    const sizes = chunks.map((c) => c.data.length);
    const minSize = Math.min(...sizes);
    const maxSize = Math.max(...sizes);

    expect(maxSize).toBeGreaterThan(minSize * 10);

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].ts).toBeGreaterThanOrEqual(chunks[i - 1].ts);
    }
  });

  it("headless terminal processes ANSI sequences correctly from real data", async () => {
    const terminal = new HeadlessTerminal({ cols: 120, rows: 40, scrollback: 5000, allowProposedApi: true });
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);

    await feedChunks(terminal, chunks, 50);

    const serialized = serializeAddon.serialize();
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized.trim().length).toBeGreaterThan(0);

    terminal.dispose();
  });

  it("serialize output can be loaded back into another headless terminal (round-trip)", async () => {
    const terminal1 = new HeadlessTerminal({ cols: 120, rows: 40, scrollback: 5000, allowProposedApi: true });
    const addon1 = new SerializeAddon();
    terminal1.loadAddon(addon1);

    await feedChunks(terminal1, chunks, 30);
    const serialized1 = addon1.serialize();

    const terminal2 = new HeadlessTerminal({ cols: 120, rows: 40, scrollback: 5000, allowProposedApi: true });
    const addon2 = new SerializeAddon();
    terminal2.loadAddon(addon2);
    await termWrite(terminal2, serialized1);
    const serialized2 = addon2.serialize();

    expect(serialized2).toBe(serialized1);

    terminal1.dispose();
    terminal2.dispose();
  });

  it("write data -> serialize -> load -> serialize again -> outputs match", async () => {
    const terminal1 = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    const addon1 = new SerializeAddon();
    terminal1.loadAddon(addon1);

    await termWrite(terminal1, "\x1b[31mRed text\x1b[0m\r\n");
    await termWrite(terminal1, "\x1b[1mBold text\x1b[0m\r\n");
    await termWrite(terminal1, "Normal text\r\n");

    const snap1 = addon1.serialize();

    const terminal2 = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    const addon2 = new SerializeAddon();
    terminal2.loadAddon(addon2);
    await termWrite(terminal2, snap1);

    const snap2 = addon2.serialize();
    expect(snap2).toBe(snap1);

    terminal1.dispose();
    terminal2.dispose();
  });

  it("full data feed produces non-empty serialize output with content", async () => {
    const terminal = new HeadlessTerminal({ cols: 120, rows: 40, scrollback: 5000, allowProposedApi: true });
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);

    await feedChunks(terminal, chunks, chunks.length);

    const serialized = serializeAddon.serialize();
    expect(serialized.length).toBeGreaterThan(100);

    terminal.dispose();
  });

  it("headless terminal captures title via OSC 0", async () => {
    const terminal = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
    const titles: string[] = [];
    terminal.onTitleChange((t: string) => titles.push(t));

    await termWrite(terminal, "\x1b]0;My Title\x07some text\r\n");

    expect(titles).toContain("My Title");
    terminal.dispose();
  });

  it("multiple serialize snapshots are stable when no new data arrives", async () => {
    const terminal = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);

    await feedChunks(terminal, chunks, 20);

    const snap1 = addon.serialize();
    const snap2 = addon.serialize();

    expect(snap2).toBe(snap1);

    terminal.dispose();
  });
});
