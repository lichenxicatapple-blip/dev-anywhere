import type { HistorySession } from "@dev-anywhere/shared";
import { describe, expect, it } from "vitest";
import { compareProvider, historySessionProvider, providerLabel } from "./session-provider";

describe("session-provider", () => {
  it("labels Cursor CLI and sorts it after Kimi", () => {
    expect(providerLabel("kimi")).toBe("Kimi Code");
    expect(providerLabel("cursor")).toBe("Cursor CLI");

    const providers = ["kimi", "cursor", "claude", "codex"] as const;
    expect([...providers].sort(compareProvider)).toEqual(["claude", "codex", "kimi", "cursor"]);
  });

  it("uses the provider reported by history discovery", () => {
    expect(historySessionProvider({ provider: "kimi" } as HistorySession)).toBe("kimi");
  });
});
