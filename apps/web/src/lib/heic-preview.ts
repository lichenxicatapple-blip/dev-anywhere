const MAX_HEIC_BYTES = 50 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 30_000;

// Decode one image at a time: an attachment gallery must not start a decoder
// (and allocate its image buffers) for every thumbnail simultaneously.
let decodeQueue: Promise<void> = Promise.resolve();

export function isHeicImagePath(path: string): boolean {
  return /\.hei[cf]$/i.test(path);
}

export function decodeHeicPreview(source: string, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, blob?: Blob) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      controller.signal.removeEventListener("abort", onCancelled);
      if (error) reject(error);
      else if (blob) resolve(blob);
    };
    const onAbort = () => controller.abort(signal.reason);
    const onCancelled = () => finish(controller.signal.reason);
    const timeout = setTimeout(
      () => controller.abort(new Error("图片读取或解码超时，请重新打开预览")),
      DECODE_TIMEOUT_MS,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    controller.signal.addEventListener("abort", onCancelled, { once: true });
    // The timeout includes queueing. Closing a queued preview settles immediately;
    // when its turn arrives, it is skipped without downloading or decoding.
    const result = decodeQueue.then(async () => {
      controller.signal.throwIfAborted();
      const response = await fetch(source, { signal: controller.signal });
      if (!response.ok) throw new Error("无法读取图片，请重新打开预览");
      if (Number(response.headers.get("content-length")) > MAX_HEIC_BYTES) {
        await response.body?.cancel();
        throw new Error("图片过大，请下载原文件查看");
      }
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("无法读取图片，请重新打开预览");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_HEIC_BYTES) {
          await reader.cancel();
          throw new Error("图片过大，请下载原文件查看");
        }
        chunks.push(value);
      }
      controller.signal.throwIfAborted();
      return decodeInWorker(new Blob(chunks), controller.signal);
    });
    decodeQueue = result.then(
      (blob) => finish(undefined, blob),
      (error: unknown) => finish(error),
    );
  });
}

function decodeInWorker(blob: Blob, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // A dedicated worker keeps decoding off the UI thread. Termination also
    // releases the library's decoder worker when the preview closes or times out.
    const worker = new Worker(new URL("./heic-preview.worker.ts", import.meta.url), {
      type: "module",
    });
    let settled = false;
    const finish = (error?: Error, result?: Blob) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("无法解码这张图片，请下载原文件查看"));
    };
    const onAbort = () => finish(new DOMException("Preview closed", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<{ blob?: Blob; error?: string }>) => {
      finish(event.data.error ? new Error(event.data.error) : undefined, event.data.blob);
    };
    worker.onerror = () => finish(new Error("无法解码这张图片，请下载原文件查看"));
    try {
      worker.postMessage(blob);
    } catch {
      finish(new Error("无法解码这张图片，请下载原文件查看"));
    }
  });
}
