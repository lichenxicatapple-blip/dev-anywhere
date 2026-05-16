import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copy-text";

const originalClipboard = navigator.clipboard;
const originalIsSecureContext = window.isSecureContext;
const originalExecCommand = document.execCommand;

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: originalIsSecureContext,
  });
  document.execCommand = originalExecCommand;
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses async Clipboard API in secure contexts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });

    await expect(copyText("hello")).resolves.toBe("clipboard");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("reports failure when Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;

    await expect(copyText("local phone text")).resolves.toBe("failed");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("reports failure instead of opening a prompt when Clipboard API is blocked", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);

    await expect(copyText("blocked")).resolves.toBe("failed");
    expect(execCommand).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
});
