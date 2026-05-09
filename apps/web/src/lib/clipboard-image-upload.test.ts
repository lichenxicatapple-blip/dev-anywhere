import { describe, expect, it, vi } from "vitest";
import { uploadClipboardImageFromPaste } from "./clipboard-image-upload";

describe("clipboard image upload flow", () => {
  it("uploads clipboard images and returns an agent file token", async () => {
    const imageFile = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const relay = {
      uploadClipboardImage: vi.fn().mockResolvedValue({
        success: true,
        path: "/home/dev/.dev-anywhere/data/s1/clipboard/shot.png",
      }),
    };

    await expect(
      uploadClipboardImageFromPaste({
        clipboardData: {
          items: [{ kind: "file", type: "image/png", getAsFile: () => imageFile }],
        } as unknown as DataTransfer,
        relay,
        sessionId: "s1",
      }),
    ).resolves.toEqual({
      path: "/home/dev/.dev-anywhere/data/s1/clipboard/shot.png",
      token: "@/home/dev/.dev-anywhere/data/s1/clipboard/shot.png ",
    });
    expect(relay.uploadClipboardImage).toHaveBeenCalledWith("s1", {
      mimeType: "image/png",
      dataBase64: "AQID",
      fileName: "shot.png",
    });
  });

  it("returns null when the paste payload has no image", async () => {
    const relay = { uploadClipboardImage: vi.fn() };

    await expect(
      uploadClipboardImageFromPaste({
        clipboardData: {
          items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
        } as unknown as DataTransfer,
        relay,
        sessionId: "s1",
      }),
    ).resolves.toBeNull();
    expect(relay.uploadClipboardImage).not.toHaveBeenCalled();
  });

  it("throws the proxy error when upload fails", async () => {
    const imageFile = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const relay = {
      uploadClipboardImage: vi.fn().mockResolvedValue({
        success: false,
        path: "",
        error: "图片超过 10MB 限制",
      }),
    };

    await expect(
      uploadClipboardImageFromPaste({
        clipboardData: {
          files: [imageFile],
        } as unknown as DataTransfer,
        relay,
        sessionId: "s1",
      }),
    ).rejects.toThrow("图片超过 10MB 限制");
  });
});
