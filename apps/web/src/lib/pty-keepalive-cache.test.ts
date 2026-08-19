import { describe, expect, it } from "vitest";
import { touchPtyKeepAliveEntry, removePtyKeepAliveEntry } from "./pty-keepalive-cache";

describe("pty keep-alive cache", () => {
  it("keeps every live PTY entry without capacity eviction", () => {
    const entries = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }];

    const next = touchPtyKeepAliveEntry(entries, "d");

    expect(next.map((entry) => entry.sessionId)).toEqual(["a", "b", "c", "d"]);
  });

  it("does not duplicate existing entries", () => {
    const entries = [{ sessionId: "a" }, { sessionId: "b" }];
    const next = touchPtyKeepAliveEntry(entries, "a");

    expect(next).toBe(entries);
  });

  it("removes terminated sessions from the cache", () => {
    const next = removePtyKeepAliveEntry([{ sessionId: "a" }, { sessionId: "b" }], "a");

    expect(next.map((entry) => entry.sessionId)).toEqual(["b"]);
  });
});
