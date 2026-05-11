import { describe, expect, it } from "vitest";
import { pickRouteToRestore } from "./route-restore";

describe("pickRouteToRestore", () => {
  it("restores last chat route on cold-start landing at root", () => {
    expect(
      pickRouteToRestore({
        pathname: "/",
        alreadyRestored: false,
        lastRoute: "/chat/abc?mode=pty",
      }),
    ).toBe("/chat/abc?mode=pty");
  });

  it("does not restore once already restored this session", () => {
    expect(
      pickRouteToRestore({
        pathname: "/",
        alreadyRestored: true,
        lastRoute: "/chat/abc?mode=pty",
      }),
    ).toBeNull();
  });

  it("does not restore when user already navigated away from root", () => {
    expect(
      pickRouteToRestore({
        pathname: "/sessions",
        alreadyRestored: false,
        lastRoute: "/chat/abc?mode=pty",
      }),
    ).toBeNull();
  });

  it("does not restore when there is no stored last route", () => {
    expect(
      pickRouteToRestore({
        pathname: "/",
        alreadyRestored: false,
        lastRoute: null,
      }),
    ).toBeNull();
  });

  it("does not restore non-chat routes (e.g. /sessions persisted by mistake)", () => {
    expect(
      pickRouteToRestore({
        pathname: "/",
        alreadyRestored: false,
        lastRoute: "/sessions",
      }),
    ).toBeNull();
  });
});
