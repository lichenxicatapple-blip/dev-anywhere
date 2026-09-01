import type { HistorySession } from "@dev-anywhere/shared";
import { describe, expect, it } from "vitest";
import { compareProvider, historySessionProvider, providerLabel } from "./session-provider";

describe("session-provider", () => {
  it("labels Kimi and sorts it after Claude and Codex", () => {
    expect(providerLabel("kimi")).toBe("Kimi Code");

    const providers = ["kimi", "claude", "codex"] as const;
    expect([...providers].sort(compareProvider)).toEqual(["claude", "codex", "kimi"]);
  });

  it("keeps the legacy history provider fallback while accepting Kimi", () => {
    expect(historySessionProvider({} as HistorySession)).toBe("claude");
    expect(historySessionProvider({ provider: "kimi" } as HistorySession)).toBe("kimi");
  });
});
