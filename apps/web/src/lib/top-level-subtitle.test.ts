import { describe, expect, it } from "vitest";
import { getTopLevelSubtitle } from "./top-level-subtitle";

const baseInput = {
  route: "proxy-select" as const,
  surface: "desktop" as const,
  proxiesLength: 0,
  hasProxy: false,
  sessionCount: 0,
};

describe("getTopLevelSubtitle", () => {
  it("does not render a subtitle when the selected developer machine has no sessions", () => {
    expect(
      getTopLevelSubtitle({
        route: "sessions",
        surface: "desktop",
        proxiesLength: 1,
        hasProxy: true,
        sessionCount: 0,
      }),
    ).toBeNull();
  });

  it("explains that a relay client token is required", () => {
    const copy = getTopLevelSubtitle({
      ...baseInput,
      relayClientAuthIssue: "missing_client_token",
    });

    expect(copy).toContain("需要 client token");
    expect(copy).toContain("设置");
    expect(copy).not.toContain("relayToken");
  });

  it("explains that a stored relay client token is invalid", () => {
    const copy = getTopLevelSubtitle({
      ...baseInput,
      relayClientAuthIssue: "invalid_client_token",
    });

    expect(copy).toContain("client token 无效");
    expect(copy).toContain("设置");
    expect(copy).not.toContain("relayToken");
  });
});
