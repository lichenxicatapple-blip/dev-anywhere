import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeRestoredTarget,
  markRestoredTarget,
  pickRouteToRestore,
} from "./route-restore";

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

describe("restored target one-shot store", () => {
  beforeEach(() => {
    globalThis.sessionStorage?.clear();
  });

  it("returns null when no restored target was ever marked", () => {
    expect(consumeRestoredTarget()).toBeNull();
  });

  it("returns the marked target on first consume", () => {
    markRestoredTarget("/chat/abc?mode=pty");
    expect(consumeRestoredTarget()).toBe("/chat/abc?mode=pty");
  });

  it("clears the target after the first consume so later calls return null", () => {
    markRestoredTarget("/chat/abc?mode=pty");
    consumeRestoredTarget();
    expect(consumeRestoredTarget()).toBeNull();
  });

  it("overwrites a previous target if mark is called twice", () => {
    markRestoredTarget("/chat/old?mode=json");
    markRestoredTarget("/chat/new?mode=pty");
    expect(consumeRestoredTarget()).toBe("/chat/new?mode=pty");
  });
});
