import { describe, expect, it, vi } from "vitest";
import {
  compressLargeImageForUpload,
  fitImageWithinMaxEdge,
  shouldCompressImageForUpload,
  type ImageUploadCompressionRuntime,
} from "./image-upload-compression";

const LARGE_FILE_SIZE = 2 * 1024 * 1024 + 1;

function fileWithSize(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type, lastModified: 1234 });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function runtimeWith(blob: Blob | null): ImageUploadCompressionRuntime {
  return {
    decode: vi.fn().mockResolvedValue({
      source: {} as CanvasImageSource,
      width: 4000,
      height: 3000,
      close: vi.fn(),
    }),
    encode: vi.fn().mockResolvedValue(blob),
  };
}

describe("image upload compression", () => {
  it("only selects large static raster images", () => {
    expect(
      shouldCompressImageForUpload(fileWithSize("large.png", "image/png", LARGE_FILE_SIZE)),
    ).toBe(true);
    expect(shouldCompressImageForUpload(fileWithSize("small.jpg", "image/jpeg", 1024))).toBe(false);
    expect(
      shouldCompressImageForUpload(fileWithSize("animated.gif", "image/gif", LARGE_FILE_SIZE)),
    ).toBe(false);
    expect(
      shouldCompressImageForUpload(fileWithSize("vector.svg", "image/svg+xml", LARGE_FILE_SIZE)),
    ).toBe(false);
    expect(
      shouldCompressImageForUpload(fileWithSize("archive.zip", "application/zip", LARGE_FILE_SIZE)),
    ).toBe(false);
    expect(
      shouldCompressImageForUpload(fileWithSize("recording.mp4", "video/mp4", LARGE_FILE_SIZE)),
    ).toBe(false);
  });

  it("keeps aspect ratio while limiting the longest edge", () => {
    expect(fitImageWithinMaxEdge(4000, 3000)).toEqual({ width: 2560, height: 1920 });
    expect(fitImageWithinMaxEdge(1200, 1800)).toEqual({ width: 1200, height: 1800 });
  });

  it("returns a WebP file when compression saves meaningful space", async () => {
    const original = fileWithSize("camera.JPG", "image/jpeg", LARGE_FILE_SIZE);
    const runtime = runtimeWith(new Blob([new Uint8Array(512 * 1024)], { type: "image/webp" }));

    const result = await compressLargeImageForUpload(original, runtime);

    expect(result).not.toBe(original);
    expect(result.name).toBe("camera.webp");
    expect(result.type).toBe("image/webp");
    expect(result.lastModified).toBe(1234);
    expect(runtime.encode).toHaveBeenCalledWith(expect.anything(), 2560, 1920, "image/webp", 0.82);
  });

  it("accepts Safari's resized PNG fallback when it is meaningfully smaller", async () => {
    const original = fileWithSize("shot.png", "image/png", LARGE_FILE_SIZE);
    const runtime = runtimeWith(new Blob([new Uint8Array(512 * 1024)], { type: "image/png" }));

    const result = await compressLargeImageForUpload(original, runtime);

    expect(result).not.toBe(original);
    expect(result.name).toBe("shot.png");
    expect(result.type).toBe("image/png");
    expect(runtime.encode).toHaveBeenCalledTimes(1);
  });

  it("uses JPEG quality compression when WebP encoding is unavailable for a JPEG", async () => {
    const original = fileWithSize("photo.jpeg", "image/jpeg", LARGE_FILE_SIZE);
    const runtime = runtimeWith(new Blob([new Uint8Array(LARGE_FILE_SIZE)], { type: "image/png" }));
    vi.mocked(runtime.encode)
      .mockResolvedValueOnce(new Blob([new Uint8Array(LARGE_FILE_SIZE)], { type: "image/png" }))
      .mockResolvedValueOnce(new Blob([new Uint8Array(512 * 1024)], { type: "image/jpeg" }));

    const result = await compressLargeImageForUpload(original, runtime);

    expect(result.name).toBe("photo.jpg");
    expect(result.type).toBe("image/jpeg");
    expect(runtime.encode).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      2560,
      1920,
      "image/jpeg",
      0.82,
    );
  });

  it("keeps the original when compression does not save at least ten percent", async () => {
    const original = fileWithSize("shot.png", "image/png", LARGE_FILE_SIZE);
    const runtime = runtimeWith(
      new Blob([new Uint8Array(Math.ceil(LARGE_FILE_SIZE * 0.91))], { type: "image/webp" }),
    );

    await expect(compressLargeImageForUpload(original, runtime)).resolves.toBe(original);
  });

  it("falls back to the original when browser decoding fails", async () => {
    const original = fileWithSize("shot.png", "image/png", LARGE_FILE_SIZE);
    const runtime: ImageUploadCompressionRuntime = {
      decode: vi.fn().mockRejectedValue(new Error("decode failed")),
      encode: vi.fn(),
    };

    await expect(compressLargeImageForUpload(original, runtime)).resolves.toBe(original);
    expect(runtime.encode).not.toHaveBeenCalled();
  });

  it("does not initialize image processing for files outside the policy", async () => {
    const original = fileWithSize("animated.gif", "image/gif", LARGE_FILE_SIZE);
    const runtime = runtimeWith(new Blob([], { type: "image/webp" }));

    await expect(compressLargeImageForUpload(original, runtime)).resolves.toBe(original);
    expect(runtime.decode).not.toHaveBeenCalled();
  });
});
