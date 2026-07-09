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

describe("app-store input mode preference persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("defaults input mode preference to auto", async () => {
    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().inputModePreference).toBe("auto");
  });

  it("loads and persists input mode preference for the current browser", async () => {
    localStorage.setItem("dev_anywhere_inputModePreference", "hardware");

    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().inputModePreference).toBe("hardware");
    useAppStore.getState().setInputModePreference("touch");

    expect(useAppStore.getState().inputModePreference).toBe("touch");
    expect(localStorage.getItem("dev_anywhere_inputModePreference")).toBe("touch");
  });

  it("falls back to auto for invalid input mode preference", async () => {
    localStorage.setItem("dev_anywhere_inputModePreference", "desktop");

    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().inputModePreference).toBe("auto");
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
