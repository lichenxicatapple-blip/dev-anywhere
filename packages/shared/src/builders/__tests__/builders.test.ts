import { describe, it, expect, beforeEach } from "vitest";
import {
  buildMessage,
  createSequenceId,
  resetSequenceCounter,
} from "../index.js";

describe("createSequenceId", () => {
  beforeEach(() => {
    resetSequenceCounter();
  });

  it("returns 0 on first call", () => {
    expect(createSequenceId()).toBe(0);
  });

  it("returns incrementing integers", () => {
    expect(createSequenceId()).toBe(0);
    expect(createSequenceId()).toBe(1);
    expect(createSequenceId()).toBe(2);
  });
});

describe("resetSequenceCounter", () => {
  it("resets to 0 by default", () => {
    createSequenceId();
    createSequenceId();
    resetSequenceCounter();
    expect(createSequenceId()).toBe(0);
  });

  it("resets to specified value", () => {
    resetSequenceCounter(10);
    expect(createSequenceId()).toBe(10);
    expect(createSequenceId()).toBe(11);
  });
});

describe("buildMessage", () => {
  beforeEach(() => {
    resetSequenceCounter();
  });

  it("builds a valid user_input envelope", () => {
    const msg = buildMessage(
      "user_input",
      "sess-1",
      { text: "hello" },
      "client",
    );
    expect(msg.type).toBe("user_input");
    expect(msg.payload).toEqual({ text: "hello" });
    expect(msg.sessionId).toBe("sess-1");
    expect(msg.source).toBe("client");
    expect(msg.version).toBe("1.0");
    expect(msg.seq).toBe(0);
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(Math.abs(msg.timestamp - Date.now())).toBeLessThan(1000);
  });

  it("builds a valid assistant_message envelope", () => {
    const msg = buildMessage(
      "assistant_message",
      "sess-1",
      { text: "hi", isPartial: false },
      "proxy",
    );
    expect(msg.type).toBe("assistant_message");
    expect(msg.payload).toEqual({ text: "hi", isPartial: false });
    expect(msg.source).toBe("proxy");
  });

  it("builds a valid error envelope", () => {
    const msg = buildMessage(
      "error",
      "sess-1",
      { code: "UNKNOWN", message: "fail" },
      "proxy",
    );
    expect(msg.type).toBe("error");
    expect(msg.payload).toEqual({ code: "UNKNOWN", message: "fail" });
  });

  it("auto-increments seq across calls", () => {
    const msg1 = buildMessage(
      "heartbeat",
      "sess-1",
      {},
      "proxy",
    );
    const msg2 = buildMessage(
      "heartbeat",
      "sess-1",
      {},
      "proxy",
    );
    expect(msg1.seq).toBe(0);
    expect(msg2.seq).toBe(1);
  });

  it("throws on invalid payload", () => {
    expect(() =>
      buildMessage(
        "user_input",
        "sess-1",
        { text: "" },
        "client",
      ),
    ).toThrow();
  });

  it("sets timestamp close to current time", () => {
    const before = Date.now();
    const msg = buildMessage("heartbeat", "sess-1", {}, "proxy");
    const after = Date.now();
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });
});
