import { describe, expect, it } from "vitest";
import { decideContainerScrollSource } from "./pty-container-scroll-model";

describe("pty container scroll model", () => {
  it("lets external sync own the scroll event before local pending markers", () => {
    expect(
      decideContainerScrollSource({
        syncingExternal: true,
        effectiveScrollTop: 100,
        pendingFollowTop: 100,
        pendingProgrammaticTop: 100,
        atBottom: false,
        canPassiveFollow: true,
      }),
    ).toEqual({
      action: "external-sync",
      nextPendingFollowTop: 100,
      nextPendingProgrammaticTop: 100,
    });
  });

  it("classifies a recent followCursorY write as programmatic follow", () => {
    expect(
      decideContainerScrollSource({
        syncingExternal: false,
        effectiveScrollTop: 250.5,
        pendingFollowTop: 250,
        pendingProgrammaticTop: 999,
        atBottom: false,
        canPassiveFollow: false,
      }),
    ).toEqual({
      action: "programmatic-follow",
      nextPendingFollowTop: null,
      nextPendingProgrammaticTop: null,
    });
  });

  it("classifies bottom programmatic drift only while passive follow is allowed", () => {
    expect(
      decideContainerScrollSource({
        syncingExternal: false,
        effectiveScrollTop: 400,
        pendingFollowTop: null,
        pendingProgrammaticTop: 400,
        atBottom: false,
        canPassiveFollow: true,
      }).action,
    ).toBe("programmatic-drift");

    expect(
      decideContainerScrollSource({
        syncingExternal: false,
        effectiveScrollTop: 400,
        pendingFollowTop: null,
        pendingProgrammaticTop: 400,
        atBottom: false,
        canPassiveFollow: false,
      }).action,
    ).toBe("continue");
  });

  it("continues as user/page handling after clearing stale pending markers", () => {
    expect(
      decideContainerScrollSource({
        syncingExternal: false,
        effectiveScrollTop: 120,
        pendingFollowTop: 80,
        pendingProgrammaticTop: 90,
        atBottom: false,
        canPassiveFollow: true,
      }),
    ).toEqual({
      action: "continue",
      nextPendingFollowTop: null,
      nextPendingProgrammaticTop: null,
    });
  });
});
