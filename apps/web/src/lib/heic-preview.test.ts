import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class PreviewWorker {
  static instances: PreviewWorker[] = [];
  onmessage: ((event: MessageEvent<{ blob: Blob }>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    PreviewWorker.instances.push(this);
  }

  complete(blob: Blob) {
    this.onmessage?.({ data: { blob } } as MessageEvent<{ blob: Blob }>);
  }
}

const fetchImage = vi.fn<typeof fetch>();
const controllers: AbortController[] = [];
let decodeHeicPreview: typeof import("./heic-preview").decodeHeicPreview;

function startPreview(source: string) {
  const controller = new AbortController();
  controllers.push(controller);
  return { controller, result: decodeHeicPreview(source, controller.signal) };
}

async function workerAt(index: number): Promise<PreviewWorker> {
  await vi.waitFor(() => expect(PreviewWorker.instances.length).toBeGreaterThan(index));
  return PreviewWorker.instances[index]!;
}

beforeEach(async () => {
  vi.resetModules();
  PreviewWorker.instances = [];
  controllers.length = 0;
  fetchImage.mockReset();
  fetchImage.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal("Worker", PreviewWorker);
  vi.stubGlobal("fetch", fetchImage);
  ({ decodeHeicPreview } = await import("./heic-preview"));
});

afterEach(() => {
  for (const controller of controllers) controller.abort();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HEIC preview resource handling", () => {
  it("cancels a queued preview promptly without fetching the image", async () => {
    let finishFetch!: (response: Response) => void;
    fetchImage.mockImplementationOnce(() => new Promise((resolve) => (finishFetch = resolve)));
    const first = startPreview("/slow-thumbnail");
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(1));
    const queued = startPreview("/closed-preview");
    const rejection = expect(queued.result).rejects.toMatchObject({ name: "AbortError" });
    queued.controller.abort();
    await rejection;
    expect(fetchImage).toHaveBeenCalledTimes(1);

    finishFetch(new Response(new Uint8Array([1, 2, 3])));
    const worker = await workerAt(0);
    const png = new Blob(["png"], { type: "image/png" });
    worker.complete(png);
    await expect(first.result).resolves.toBe(png);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("continues with another image after a download fails", async () => {
    fetchImage.mockRejectedValueOnce(new Error("connection lost"));
    const first = startPreview("/unavailable");
    const second = startPreview("/available");
    await expect(first.result).rejects.toThrow("connection lost");
    const worker = await workerAt(0);
    const png = new Blob(["png"], { type: "image/png" });
    worker.complete(png);
    await expect(second.result).resolves.toBe(png);
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a failed decoder and allows the next image to decode", async () => {
    const first = startPreview("/broken.heic");
    const rejection = expect(first.result).rejects.toThrow("无法解码");
    const failedWorker = await workerAt(0);
    const second = startPreview("/photo.heic");
    failedWorker.onerror?.();
    await rejection;
    expect(failedWorker.terminate).toHaveBeenCalledOnce();
    const nextWorker = await workerAt(1);
    const png = new Blob(["png"], { type: "image/png" });
    nextWorker.complete(png);
    await expect(second.result).resolves.toBe(png);
    expect(nextWorker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects an oversized streaming body even without Content-Length", async () => {
    const cancel = vi.fn();
    fetchImage.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new Uint8Array(25 * 1024 * 1024));
            stream.enqueue(new Uint8Array(25 * 1024 * 1024 + 1));
          },
          cancel,
        }),
      ),
    );
    const preview = startPreview("/oversized.heic");
    await expect(preview.result).rejects.toThrow("图片过大");
    expect(cancel).toHaveBeenCalledOnce();
    expect(PreviewWorker.instances).toHaveLength(0);
  });

  it("terminates an active decoder when its preview closes", async () => {
    const preview = startPreview("/photo.heic");
    const rejection = expect(preview.result).rejects.toMatchObject({ name: "AbortError" });
    const worker = await workerAt(0);
    preview.controller.abort();
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("times out an unresponsive decoder, cleans it up, and can decode another image", async () => {
    vi.useFakeTimers();
    const preview = startPreview("/unresponsive.heic");
    const rejection = expect(preview.result).rejects.toThrow("超时");
    const worker = await workerAt(0);
    await vi.advanceTimersByTimeAsync(30_001);
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();

    const next = startPreview("/photo.heic");
    const nextWorker = await workerAt(1);
    const png = new Blob(["png"], { type: "image/png" });
    nextWorker.complete(png);
    await expect(next.result).resolves.toBe(png);
  });

  it("counts time spent behind another image toward the preview timeout", async () => {
    vi.useFakeTimers();
    const first = startPreview("/slow-thumbnail.heic");
    const firstWorker = await workerAt(0);
    const queued = startPreview("/opened-preview.heic");
    const rejection = expect(queued.result).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(25_000);
    const png = new Blob(["png"], { type: "image/png" });
    firstWorker.complete(png);
    await expect(first.result).resolves.toBe(png);

    const queuedWorker = await workerAt(1);
    await vi.advanceTimersByTimeAsync(5_001);
    await rejection;
    expect(queuedWorker.terminate).toHaveBeenCalledOnce();
  });
});
