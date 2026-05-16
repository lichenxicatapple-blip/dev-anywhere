import { describe, expect, it } from "vitest";
import { touchPtyKeepAliveEntry, removePtyKeepAliveEntry } from "./pty-keepalive-cache";

describe("pty keep-alive cache", () => {
  it("keeps the current session and evicts the least recently used hidden entry", () => {
    const now = 1000;
    const entries = [
      { sessionId: "a", touchedAt: now },
      { sessionId: "b", touchedAt: now + 1 },
      { sessionId: "c", touchedAt: now + 2 },
    ];

    const next = touchPtyKeepAliveEntry(entries, "d", {
      capacity: 3,
      now: now + 3,
      activeSessionId: "a",
    });

    expect(next.map((entry) => entry.sessionId)).toEqual(["a", "c", "d"]);
  });

  it("refreshes touchedAt for existing entries without duplicating them", () => {
    const next = touchPtyKeepAliveEntry(
      [
        { sessionId: "a", touchedAt: 1 },
        { sessionId: "b", touchedAt: 2 },
      ],
      "a",
      { capacity: 3, now: 10, activeSessionId: "a" },
    );

    expect(next).toEqual([
      { sessionId: "a", touchedAt: 10 },
      { sessionId: "b", touchedAt: 2 },
    ]);
  });

  it("removes terminated sessions from the cache", () => {
    const next = removePtyKeepAliveEntry(
      [
        { sessionId: "a", touchedAt: 1 },
        { sessionId: "b", touchedAt: 2 },
      ],
      "a",
    );

    expect(next.map((entry) => entry.sessionId)).toEqual(["b"]);
  });
});
