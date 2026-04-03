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
    const mod = await import("../line-buffer.js");
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
});
