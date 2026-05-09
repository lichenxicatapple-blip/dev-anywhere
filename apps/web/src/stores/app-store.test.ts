import { beforeEach, describe, expect, it, vi } from "vitest";

describe("app-store font size persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("uses readable defaults when font size storage keys are absent", async () => {
    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().ptyFontSize).toBe(14);
    expect(useAppStore.getState().chatContentFontSize).toBe(14);
  });

  it("falls back to defaults for empty or invalid stored font sizes", async () => {
    localStorage.setItem("cc_ptyFontSize", "");
    localStorage.setItem("dev_anywhere_chatContentFontSize", "not-a-number");

    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().ptyFontSize).toBe(14);
    expect(useAppStore.getState().chatContentFontSize).toBe(14);
  });

  it("still clamps explicit stored font sizes into the supported range", async () => {
    localStorage.setItem("cc_ptyFontSize", "7");
    localStorage.setItem("dev_anywhere_chatContentFontSize", "32");

    const { useAppStore } = await import("./app-store");

    expect(useAppStore.getState().ptyFontSize).toBe(8);
    expect(useAppStore.getState().chatContentFontSize).toBe(24);
  });
});
