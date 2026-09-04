import { describe, expect, it, vi } from "vitest";
import {
  PtySynchronizedOutputCoalescer,
  type PtySynchronizedOutputOverflow,
} from "#src/common/pty-synchronized-output-coalescer.js";

const START = "\x1b[?2026h";
const END = "\x1b[?2026l";

function createCoalescer(options: { maxBufferedBytes?: number } = {}) {
  const output: string[] = [];
  const overflows: PtySynchronizedOutputOverflow[] = [];
  const coalescer = new PtySynchronizedOutputCoalescer({
    emit: (data) => output.push(data),
    onOverflow: (event) => overflows.push(event),
    ...options,
  });
  return { coalescer, output, overflows };
}

describe("PtySynchronizedOutputCoalescer", () => {
  it("emits ordinary output immediately", () => {
    const { coalescer, output } = createCoalescer();

    coalescer.push("hello");
    coalescer.push(" world");

    expect(output).toEqual(["hello", " world"]);
  });

  it("emits a complete synchronized-output transaction exactly once", () => {
    const { coalescer, output } = createCoalescer();
    const transaction = `${START}first\r\nsecond${END}`;

    for (const char of `before${transaction}after`) coalescer.push(char);

    expect(output.join("")).toBe(`before${transaction}after`);
    expect(output.filter((chunk) => chunk === transaction)).toHaveLength(1);
  });

  it("recognizes markers across every possible chunk boundary", () => {
    const input = `prefix${START}内容🙂${END}suffix`;

    for (let split = 0; split <= input.length; split += 1) {
      const { coalescer, output } = createCoalescer();
      coalescer.push(input.slice(0, split));
      coalescer.push(input.slice(split));
      coalescer.flush();
      expect(output.join(""), `split=${split}`).toBe(input);
      expect(output).toContain(`${START}内容🙂${END}`);
    }
  });

  it("ignores marker-shaped bytes inside OSC, DCS, and APC strings", () => {
    const fakeMarkers = [
      `\x1b]0;title-${START}-${END}\x07`,
      `\x1bPpayload-${START}-${END}\x1b\\`,
      `\x1b_payload-${START}-${END}\x1b\\`,
    ];

    for (const input of fakeMarkers) {
      const { coalescer, output } = createCoalescer();
      for (const char of input) coalescer.push(char);
      coalescer.flush();
      expect(output.join("")).toBe(input);
      expect(output).not.toContain(
        input.slice(input.indexOf(START), input.indexOf(END) + END.length),
      );
    }
  });

  it("passes an over-cap transaction through losslessly until its end marker", () => {
    const { coalescer, output, overflows } = createCoalescer({ maxBufferedBytes: 24 });
    const transaction = `${START}${"雪".repeat(8)}${END}`;

    coalescer.push(transaction.slice(0, 12));
    coalescer.push(transaction.slice(12));
    coalescer.push("tail");

    expect(output.join("")).toBe(`${transaction}tail`);
    expect(overflows).toEqual([
      {
        reason: "byte-cap",
        maxBufferedBytes: 24,
        bufferedBytes: 20,
        incomingBytes: 20,
        transactionBytes: 40,
      },
    ]);
  });

  it("idle-flushes an incomplete transaction and remains passthrough until reset", () => {
    vi.useFakeTimers();
    try {
      const output: string[] = [];
      const coalescer = new PtySynchronizedOutputCoalescer({
        emit: (data) => output.push(data),
        idleTimeoutMs: 2_000,
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: (handle) => clearTimeout(handle),
      });

      coalescer.push(`${START}partial`);
      expect(output).toEqual([]);
      vi.advanceTimersByTime(1_999);
      expect(output).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(output.join("")).toBe(`${START}partial`);

      coalescer.push(`more${START}still-same${END}after`);
      expect(output.join("")).toBe(`${START}partialmore${START}still-same${END}after`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush and dispose emit all pending bytes without duplicates", () => {
    const flushed = createCoalescer();
    flushed.coalescer.push(`plain\x1b[?20`);
    flushed.coalescer.flush();
    expect(flushed.output.join("")).toBe(`plain\x1b[?20`);

    const disposed = createCoalescer();
    disposed.coalescer.push(`${START}unfinished`);
    disposed.coalescer.dispose();
    disposed.coalescer.dispose();
    disposed.coalescer.push("ignored");
    expect(disposed.output.join("")).toBe(`${START}unfinished`);
  });

  it.each([
    ["OSC", "\x1b]0;", "\x07"],
    ["DCS", "\x1bP", "\x1b\\"],
    ["APC", "\x1b_", "\x1b\\"],
  ])(
    "keeps %s string context across a flush inside a synchronized transaction",
    (_name, stringStart, stringEnd) => {
      const { coalescer, output } = createCoalescer();
      const prefix = `${START}${stringStart}prefix-`;
      const suffix = `${START}fake${END}${stringEnd}body${END}tail`;

      coalescer.push(prefix);
      coalescer.flush();
      expect(output).toEqual([prefix]);

      coalescer.push(suffix);
      expect(output).toEqual([prefix, `${START}fake${END}${stringEnd}body${END}`, "tail"]);
      expect(output.join("")).toBe(prefix + suffix);
    },
  );

  it("keeps an outside OSC introducer split by flush from exposing fake markers", () => {
    const { coalescer, output } = createCoalescer();

    coalescer.push("\x1b");
    coalescer.flush();
    coalescer.push(`]0;${START}fake${END}\x07tail`);

    expect(output).toEqual(["\x1b", `]0;${START}fake${END}\x07tail`]);
  });

  it("stays in passthrough after flushing an incomplete synchronized transaction", () => {
    const { coalescer, output } = createCoalescer();
    const prefix = `${START}partial`;

    coalescer.push(prefix);
    coalescer.flush();
    coalescer.push(`${START}repeated`);

    expect(output.join("")).toBe(`${prefix}${START}repeated`);

    coalescer.push(`${END}tail`);
    expect(output.join("")).toBe(`${prefix}${START}repeated${END}tail`);
    expect(output.at(-1)).toBe("tail");
  });

  it("does not recognize a marker candidate whose prefix was explicitly flushed", () => {
    const { coalescer, output } = createCoalescer();

    coalescer.push("\x1b[?20");
    coalescer.flush();
    coalescer.push("26hnot-a-transaction");

    expect(output).toEqual(["\x1b[?20", "26hnot-a-transaction"]);

    const transaction = `${START}next${END}`;
    coalescer.push(transaction);
    expect(output.at(-1)).toBe(transaction);
  });

  it("still recognizes an end marker split by a flush of the active transaction", () => {
    const { coalescer, output } = createCoalescer();
    const flushedPrefix = `${START}body\x1b[?20`;

    coalescer.push(flushedPrefix);
    coalescer.flush();
    coalescer.push("26l");
    expect(output.join("")).toBe(`${flushedPrefix}26l`);

    const nextTransaction = `${START}next${END}`;
    coalescer.push(nextTransaction.slice(0, -END.length));
    expect(output.join("")).toBe(`${flushedPrefix}26l`);
    coalescer.push(END);
    expect(output.at(-1)).toBe(nextTransaction);
  });
});
