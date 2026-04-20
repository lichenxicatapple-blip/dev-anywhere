import { describe, it, expect } from "vitest";
import { buildMessage } from "../index.js";

describe("buildMessage", () => {
  it("builds a valid user_input envelope with provided seq", () => {
    const msg = buildMessage("user_input", "sess-1", 1, { text: "hello" }, "client");
    expect(msg.type).toBe("user_input");
    expect(msg.payload).toEqual({ text: "hello" });
    expect(msg.sessionId).toBe("sess-1");
    expect(msg.source).toBe("client");
    expect(msg.version).toBe("1.0");
    expect(msg.seq).toBe(1);
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  it("builds a valid assistant_message envelope", () => {
    const msg = buildMessage(
      "assistant_message",
      "sess-1",
      5,
      { text: "hi", isPartial: false },
      "proxy",
    );
    expect(msg.type).toBe("assistant_message");
    expect(msg.seq).toBe(5);
    expect(msg.payload).toEqual({ text: "hi", isPartial: false });
    expect(msg.source).toBe("proxy");
  });

  it("builds a valid error envelope", () => {
    const msg = buildMessage("error", "sess-1", 10, { code: "UNKNOWN", message: "fail" }, "proxy");
    expect(msg.type).toBe("error");
    expect(msg.payload).toEqual({ code: "UNKNOWN", message: "fail" });
  });

  it("uses the seq value provided by caller", () => {
    const msg1 = buildMessage("heartbeat", "sess-1", 42, {}, "proxy");
    const msg2 = buildMessage("heartbeat", "sess-1", 43, {}, "proxy");
    expect(msg1.seq).toBe(42);
    expect(msg2.seq).toBe(43);
  });

  it("throws on invalid payload", () => {
    expect(() => buildMessage("user_input", "sess-1", 1, { text: "" }, "client")).toThrow();
  });

  it("sets timestamp close to current time", () => {
    const before = Date.now();
    const msg = buildMessage("heartbeat", "sess-1", 0, {}, "proxy");
    const after = Date.now();
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });
});
