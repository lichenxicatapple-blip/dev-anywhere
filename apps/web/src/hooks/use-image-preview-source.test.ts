import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeHeicPreview } from "@/lib/heic-preview";
import { useImagePreviewSource } from "./use-image-preview-source";

vi.mock("@/lib/heic-preview", async (original) => ({
  ...(await original<typeof import("@/lib/heic-preview")>()),
  decodeHeicPreview: vi.fn(),
}));

const decode = vi.mocked(decodeHeicPreview);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:decoded");
      static revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("useImagePreviewSource", () => {
  it("uses native HEIC decoding until the image reports an error", async () => {
    decode.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const { result, unmount } = renderHook(() => useImagePreviewSource("/photo", "photo.HEIC"));
    expect(result.current.src).toBe("/photo");
    expect(decode).not.toHaveBeenCalled();
    act(() => result.current.onError());
    expect(result.current.loading).toBe(true);
    expect(result.current.src).toBe("");
    await waitFor(() => expect(result.current.src).toBe("blob:decoded"));
    expect(result.current.error).toBe("");
    const signal = decode.mock.calls[0][1];
    unmount();
    expect(signal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:decoded");
  });

  it("does not fetch or load a HEIC decoder for a broken regular image", () => {
    const { result } = renderHook(() => useImagePreviewSource("/photo", "photo.png"));
    act(() => result.current.onError());
    expect(result.current.error).not.toBe("");
    expect(decode).not.toHaveBeenCalled();
  });

  it("reports conversion failure without retrying in a loop", async () => {
    decode.mockRejectedValue(new Error("无法解码"));
    const { result } = renderHook(() => useImagePreviewSource("/photo", "photo.heif"));
    act(() => result.current.onError());
    await waitFor(() => expect(result.current.error).toBe("无法解码"));
    expect(result.current.loading).toBe(false);
    act(() => result.current.onError());
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("aborts an old preview and ignores late conversion results after switching images", async () => {
    let finish!: (blob: Blob) => void;
    decode.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ source, path }) => useImagePreviewSource(source, path),
      {
        initialProps: { source: "/old", path: "old.heic" },
      },
    );
    act(() => result.current.onError());
    const signal = decode.mock.calls[0][1];
    rerender({ source: "/new", path: "new.png" });
    expect(signal.aborted).toBe(true);
    await act(async () => finish(new Blob(["old"])));
    expect(result.current.src).toBe("/new");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("starts fresh when reopening the same source after closing", async () => {
    decode.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const { result, rerender } = renderHook(
      ({ source }) => useImagePreviewSource(source, "photo.heic"),
      {
        initialProps: { source: "/photo" },
      },
    );
    act(() => result.current.onError());
    await waitFor(() => expect(result.current.src).toBe("blob:decoded"));
    rerender({ source: "" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:decoded");
    rerender({ source: "/photo" });
    expect(result.current.src).toBe("/photo");
    expect(result.current.error).toBe("");
    act(() => result.current.onError());
    await waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
  });
});
