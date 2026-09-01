import { describe, expect, it, vi } from "vitest";
import { LatestDevicePreviewFramePainter } from "./device-preview-frame-painter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function bitmap(width: number, height: number): ImageBitmap {
  return {
    width,
    height,
    close: vi.fn(),
  } as unknown as ImageBitmap;
}

function canvasHarness() {
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  };
  const canvas = {
    width: 300,
    height: 150,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  return { canvas, context };
}

describe("LatestDevicePreviewFramePainter", () => {
  it("accepts a reset sequence after a new stream is acquired", async () => {
    const { canvas, context } = canvasHarness();
    const decoder = vi
      .fn<(jpeg: Uint8Array) => Promise<ImageBitmap>>()
      .mockResolvedValueOnce(bitmap(390, 844))
      .mockResolvedValueOnce(bitmap(390, 844));
    const painter = new LatestDevicePreviewFramePainter(canvas, vi.fn(), decoder);

    painter.enqueue(50, Uint8Array.of(50));
    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(1));
    painter.reset();
    painter.enqueue(0, Uint8Array.of(0));

    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(2));
    expect(decoder).toHaveBeenCalledTimes(2);
  });

  it("reports the frame size again after reset even when its dimensions did not change", async () => {
    const { canvas, context } = canvasHarness();
    const onSize = vi.fn();
    const decoder = vi
      .fn<(jpeg: Uint8Array) => Promise<ImageBitmap>>()
      .mockResolvedValueOnce(bitmap(390, 844))
      .mockResolvedValueOnce(bitmap(390, 844));
    const painter = new LatestDevicePreviewFramePainter(canvas, onSize, decoder);

    painter.enqueue(10, Uint8Array.of(10));
    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(1));
    painter.reset();
    painter.enqueue(0, Uint8Array.of(0));

    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(2));
    expect(onSize).toHaveBeenNthCalledWith(1, { width: 390, height: 844 });
    expect(onSize).toHaveBeenNthCalledWith(2, { width: 390, height: 844 });
  });

  it("reports a size change when the same stream rotates", async () => {
    const { canvas, context } = canvasHarness();
    const onSize = vi.fn();
    const decoder = vi
      .fn<(jpeg: Uint8Array) => Promise<ImageBitmap>>()
      .mockResolvedValueOnce(bitmap(390, 844))
      .mockResolvedValueOnce(bitmap(844, 390));
    const painter = new LatestDevicePreviewFramePainter(canvas, onSize, decoder);

    painter.enqueue(1, Uint8Array.of(1));
    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(1));
    painter.enqueue(2, Uint8Array.of(2));

    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(2));
    expect(onSize).toHaveBeenNthCalledWith(1, { width: 390, height: 844 });
    expect(onSize).toHaveBeenNthCalledWith(2, { width: 844, height: 390 });
  });

  it("does not paint a stale decode after the stream generation changes", async () => {
    const { canvas, context } = canvasHarness();
    const oldDecode = deferred<ImageBitmap>();
    const newDecode = deferred<ImageBitmap>();
    const decoder = vi
      .fn<(jpeg: Uint8Array) => Promise<ImageBitmap>>()
      .mockReturnValueOnce(oldDecode.promise)
      .mockReturnValueOnce(newDecode.promise);
    const painter = new LatestDevicePreviewFramePainter(canvas, vi.fn(), decoder);

    painter.enqueue(90, Uint8Array.of(90));
    painter.reset();
    painter.enqueue(0, Uint8Array.of(0));
    const oldBitmap = bitmap(390, 844);
    oldDecode.resolve(oldBitmap);
    await vi.waitFor(() => expect(decoder).toHaveBeenCalledTimes(2));
    const newBitmap = bitmap(844, 390);
    newDecode.resolve(newBitmap);

    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(1));
    expect(context.drawImage).toHaveBeenCalledWith(newBitmap, 0, 0);
    expect(oldBitmap.close).toHaveBeenCalledTimes(1);
  });

  it("drops an older decode when a newer frame is already queued", async () => {
    const { canvas, context } = canvasHarness();
    const firstDecode = deferred<ImageBitmap>();
    const decoder = vi
      .fn<(jpeg: Uint8Array) => Promise<ImageBitmap>>()
      .mockReturnValueOnce(firstDecode.promise)
      .mockResolvedValueOnce(bitmap(390, 844));
    const painter = new LatestDevicePreviewFramePainter(canvas, vi.fn(), decoder);

    painter.enqueue(1, Uint8Array.of(1));
    painter.enqueue(2, Uint8Array.of(2));
    firstDecode.resolve(bitmap(390, 844));

    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(1));
    expect(decoder).toHaveBeenCalledTimes(2);
  });
});
