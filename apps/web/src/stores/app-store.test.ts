import { beforeEach, describe, expect, it, vi } from "vitest";

describe("app-store font size persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("uses readable defaults when font size storage keys are absent", async () => {
    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().ptyFontSize).toBe(16);
    expect(useAppStore.getState().chatContentFontSize).toBe(16);
  });

  it("falls back to defaults for empty or invalid stored font sizes", async () => {
    localStorage.setItem("dev_anywhere_ptyFontSize", "");
    localStorage.setItem("dev_anywhere_chatContentFontSize", "not-a-number");

    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().ptyFontSize).toBe(16);
    expect(useAppStore.getState().chatContentFontSize).toBe(16);
  });

  it("still clamps explicit stored font sizes into the supported range", async () => {
    localStorage.setItem("dev_anywhere_ptyFontSize", "7");
    localStorage.setItem("dev_anywhere_chatContentFontSize", "32");

    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().ptyFontSize).toBe(8);
    expect(useAppStore.getState().chatContentFontSize).toBe(24);
  });
});

describe("app-store desktop interaction mode persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("defaults desktop interaction mode to off", async () => {
    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().desktopInteractionMode).toBe(false);
  });

  it("loads and persists desktop interaction mode for the current browser", async () => {
    localStorage.setItem("dev_anywhere_desktopInteractionMode", "1");

    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().desktopInteractionMode).toBe(true);
    useAppStore.getState().setDesktopInteractionMode(false);

    expect(useAppStore.getState().desktopInteractionMode).toBe(false);
    expect(localStorage.getItem("dev_anywhere_desktopInteractionMode")).toBe("0");
  });
});

describe("app-store PTY scroll trace persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("defaults PTY scroll trace to off", async () => {
    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().ptyScrollTraceEnabled).toBe(false);
  });

  it("loads and persists PTY scroll trace for the current browser", async () => {
    localStorage.setItem("dev_anywhere_pty_scroll_trace", "1");

    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().ptyScrollTraceEnabled).toBe(true);
    useAppStore.getState().setPtyScrollTraceEnabled(false);

    expect(useAppStore.getState().ptyScrollTraceEnabled).toBe(false);
    expect(localStorage.getItem("dev_anywhere_pty_scroll_trace")).toBe("0");
  });
});
