import { describe, expect, it } from "vitest";
import { getTopLevelSubtitle } from "./top-level-subtitle";

const baseInput = {
  route: "proxy-select" as const,
  surface: "desktop" as const,
  proxiesLength: 0,
  proxyListLoaded: true,
  hasProxy: false,
  sessionCount: 0,
};

describe("getTopLevelSubtitle", () => {
  it("does not treat an unloaded proxy list as an empty proxy list", () => {
    expect(
      getTopLevelSubtitle({
        ...baseInput,
        proxyListLoaded: false,
      }),
    ).toBeNull();
  });

  it("renders the no-proxy subtitle only after an authoritative empty list arrives", () => {
    expect(getTopLevelSubtitle(baseInput)).toBe(
      "在开发机上启动 DEV Anywhere，本页会显示可连接的开发机",
    );
  });

  it("does not render a subtitle for a selected developer machine", () => {
    for (const sessionCount of [0, 3]) {
      expect(
        getTopLevelSubtitle({
          route: "sessions",
          surface: "desktop",
          proxiesLength: 1,
          proxyListLoaded: true,
          hasProxy: true,
          sessionCount,
        }),
      ).toBeNull();
    }
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

  it.each([
    ["missing_client_token" as const, "Relay 需要 client token，请在设置中填写"],
    ["invalid_client_token" as const, "client token 无效或已过期，请在设置中更新"],
  ])("prioritizes %s over an unloaded proxy list", (relayClientAuthIssue, expected) => {
    expect(
      getTopLevelSubtitle({
        ...baseInput,
        proxyListLoaded: false,
        relayClientAuthIssue,
      }),
    ).toBe(expected);
  });
});
