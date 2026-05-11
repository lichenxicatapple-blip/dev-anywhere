import { describe, it, expect } from "vitest";
import { Transform } from "node:stream";

// 收集 Transform stream 的所有输出 chunk
function collectOutput(stream: Transform): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    });
    stream.on("end", () => resolve(chunks));
    stream.on("error", reject);
  });
}

describe("LineBuffer", () => {
  async function importLineBuffer() {
    const mod = await import("#src/ipc/line-buffer.js");
    return mod.LineBuffer;
  }

  it("emits a single complete line", async () => {
    const LineBuffer = await importLineBuffer();
    const lb = new LineBuffer();
    const output = collectOutput(lb);

    lb.write("hello\n");
    lb.end();

    expect(await output).toEqual(["hello"]);
  });

  it("emits multiple lines from one chunk", async () => {
    const LineBuffer = await importLineBuffer();
    const lb = new LineBuffer();
    const output = collectOutput(lb);

    lb.write("a\nb\nc\n");
    lb.end();

    expect(await output).toEqual(["a", "b", "c"]);
  });

  it("assembles a line split across two chunks", async () => {
    const LineBuffer = await importLineBuffer();
    const lb = new LineBuffer();
    const output = collectOutput(lb);

    lb.write("hel");
    lb.write("lo\n");
    lb.end();

    expect(await output).toEqual(["hello"]);
  });

  it("assembles a line split across 3+ chunks", async () => {
    const LineBuffer = await importLineBuffer();
    const lb = new LineBuffer();
    const output = collectOutput(lb);

    lb.write("abc");
    lb.write("def");
    lb.write("ghi\n");
    lb.end();

    expect(await output).toEqual(["abcdefghi"]);
  });

  it("handles mixed complete and partial lines", async () => {
    const LineBuffer = await importLineBuffer();
    const lb = new LineBuffer();
    const output = collectOutput(lb);

    lb.write("line1\npar");
    lb.write("tial\n");
    lb.end();

    expect(await output).toEqual(["line1", "partial"]);
  });

  it("skips empty lines", async () => {
    const LineBuffer = await importLineBuffer();
    const lb = new LineBuffer();
    const output = collectOutput(lb);

    lb.write("a\n\nb\n");
    lb.end();

    expect(await output).toEqual(["a", "b"]);
  });

  it("flushes trailing content without newline", async () => {
    const LineBuffer = await importLineBuffer();
    const lb = new LineBuffer();
    const output = collectOutput(lb);

    lb.write("trailing");
    lb.end();

    expect(await output).toEqual(["trailing"]);
  });

  it("emits nothing when no data is written", async () => {
    const LineBuffer = await importLineBuffer();
    const lb = new LineBuffer();
    const output = collectOutput(lb);

    lb.end();

    expect(await output).toEqual([]);
  });

  // claude/codex CLI 的 stream-json 含 CJK / emoji。Buffer.toString() 直接对单 chunk
  // 调用, 多字节字符 (UTF-8 4 字节 emoji / 3 字节 CJK) 跨 chunk 边界时, 单 chunk 解码会
  // 把不完整字节序列变成 U+FFFD 替换字符。需用 StringDecoder 跨 chunk 缓存不完整字节。
  it("preserves multi-byte UTF-8 character split across two chunks (emoji)", async () => {
    const LineBuffer = await importLineBuffer();
    const lb = new LineBuffer();
    const output = collectOutput(lb);

    // 🎉 = U+1F389 = F0 9F 8E 89 (4 bytes)
    const emoji = Buffer.from("🎉", "utf-8");
    expect(emoji.length).toBe(4);
    // 把 emoji 的字节切到两个 chunk: 第一段 [F0], 第二段 [9F 8E 89]
    lb.write(Buffer.concat([Buffer.from("a"), emoji.slice(0, 1)]));
    lb.write(Buffer.concat([emoji.slice(1), Buffer.from("\n")]));
    lb.end();

    const lines = await output;
    expect(lines).toEqual(["a🎉"]);
  });

  it("preserves CJK character split across chunks", async () => {
    const LineBuffer = await importLineBuffer();
    const lb = new LineBuffer();
    const output = collectOutput(lb);

    // 中 = U+4E2D = E4 B8 AD (3 bytes)
    const cjk = Buffer.from("中", "utf-8");
    expect(cjk.length).toBe(3);
    lb.write(cjk.slice(0, 2));
    lb.write(Buffer.concat([cjk.slice(2), Buffer.from("\n")]));
    lb.end();

    expect(await output).toEqual(["中"]);
  });
});
