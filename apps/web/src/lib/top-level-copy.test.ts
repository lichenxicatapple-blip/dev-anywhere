import { describe, expect, it } from "vitest";
import { getTopLevelSubtitle } from "./top-level-copy";

const baseInput = {
  route: "proxy-select" as const,
  surface: "desktop" as const,
  proxiesLength: 0,
  hasProxy: false,
  sessionCount: 0,
};

describe("getTopLevelSubtitle", () => {
  it("explains that a relay client token is required", () => {
    expect(
      getTopLevelSubtitle({
        ...baseInput,
        relayClientAuthIssue: "missing_client_token",
      }),
    ).toContain("需要 client token");
  });

  it("explains that a stored relay client token is invalid", () => {
    expect(
      getTopLevelSubtitle({
        ...baseInput,
        relayClientAuthIssue: "invalid_client_token",
      }),
    ).toContain("client token 无效");
  });
});
