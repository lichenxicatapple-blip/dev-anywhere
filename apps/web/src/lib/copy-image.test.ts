import { afterEach, describe, expect, it, vi } from "vitest";
import { copyLoadedImageToClipboard } from "./copy-image";

const originalClipboard = navigator.clipboard;
const originalClipboardItem = globalThis.ClipboardItem;
const originalIsSecureContext = window.isSecureContext;

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value: originalClipboardItem,
  });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: originalIsSecureContext,
  });
  vi.restoreAllMocks();
});

describe("copyLoadedImageToClipboard", () => {
  it("normalizes and copies an already loaded image with the async Clipboard API", async () => {
    const normalizedBlob = new Blob(["normalized"], { type: "image/png" });
    class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
    }
    const write = vi.fn(async (items: ClipboardItemMock[]) => {
      await items[0]?.items["image/png"];
    });

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: ClipboardItemMock,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(normalizedBlob);
    });

    await expect(copyLoadedImageToClipboard(loadedImage())).resolves.toBe("copied");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]?.[0]).toBeInstanceOf(ClipboardItemMock);
    await expect(
      (write.mock.calls[0]?.[0]?.[0] as ClipboardItemMock).items["image/png"],
    ).resolves.toBe(normalizedBlob);
  });

  it("rejects images that have not finished loading", async () => {
    const image = document.createElement("img");
    Object.defineProperty(image, "complete", { configurable: true, value: false });

    await expect(copyLoadedImageToClipboard(image)).resolves.toBe("not-ready");
  });

  it("does not encode the image when the page is not a secure context", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");

    await expect(copyLoadedImageToClipboard(loadedImage())).resolves.toBe("insecure");
    expect(getContext).not.toHaveBeenCalled();
  });

  it("reports unsupported when the image Clipboard API is unavailable", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");

    await expect(copyLoadedImageToClipboard(loadedImage())).resolves.toBe("unsupported");
    expect(getContext).not.toHaveBeenCalled();
  });

  it("reports a failed image conversion through the pending clipboard item", async () => {
    class ClipboardItemMock {
      constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
    }
    const write = vi.fn(async (items: ClipboardItemMock[]) => {
      await items[0]?.items["image/png"];
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: ClipboardItemMock,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(null);
    });

    await expect(copyLoadedImageToClipboard(loadedImage())).resolves.toBe("failed");
    expect(write).toHaveBeenCalledTimes(1);
  });
});

function loadedImage(): HTMLImageElement {
  const image = document.createElement("img");
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: 640 },
    naturalHeight: { configurable: true, value: 480 },
  });
  return image;
}
