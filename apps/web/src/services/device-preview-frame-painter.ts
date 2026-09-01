export interface DevicePreviewFrameSize {
  width: number;
  height: number;
}

type FrameBitmapDecoder = (jpeg: Uint8Array) => Promise<ImageBitmap>;

interface PendingFrame {
  generation: number;
  sequence: number;
  jpeg: Uint8Array;
}

async function decodeJpeg(jpeg: Uint8Array): Promise<ImageBitmap> {
  const bytes = jpeg.slice();
  return createImageBitmap(new Blob([bytes.buffer], { type: "image/jpeg" }));
}

/** Paints only the newest decoded frame and lets a new HTTP stream restart its sequence at zero. */
export class LatestDevicePreviewFramePainter {
  private latest: PendingFrame | null = null;
  private painting = false;
  private disposed = false;
  private generation = 0;
  private lastSequence = -1;
  private sizeReportedGeneration = -1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onSize: (size: DevicePreviewFrameSize) => void,
    private readonly decoder: FrameBitmapDecoder = decodeJpeg,
  ) {}

  enqueue(sequence: number, jpeg: Uint8Array): void {
    if (this.disposed || sequence <= this.lastSequence) return;
    if (this.latest?.generation === this.generation && sequence <= this.latest.sequence) {
      return;
    }
    this.latest = {
      generation: this.generation,
      sequence,
      jpeg: jpeg.slice(),
    };
    if (!this.painting) void this.paintLoop();
  }

  /** A newly acquired stream has its own sequence space, which commonly starts again at zero. */
  reset(clearFrame = false): void {
    if (this.disposed) return;
    this.generation += 1;
    this.latest = null;
    this.lastSequence = -1;
    if (clearFrame) {
      this.canvas
        .getContext("2d", { alpha: false })
        ?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.latest = null;
  }

  private async paintLoop(): Promise<void> {
    this.painting = true;
    try {
      while (!this.disposed && this.latest) {
        const frame = this.latest;
        this.latest = null;
        let bitmap: ImageBitmap;
        try {
          bitmap = await this.decoder(frame.jpeg);
        } catch (error) {
          if (!this.disposed && frame.generation === this.generation) {
            console.warn("Failed to decode device preview frame", error);
          }
          continue;
        }
        try {
          if (
            this.disposed ||
            frame.generation !== this.generation ||
            frame.sequence <= this.lastSequence ||
            this.hasNewerQueuedFrame(frame)
          ) {
            continue;
          }
          const sizeChanged =
            this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height;
          if (sizeChanged) {
            this.canvas.width = bitmap.width;
            this.canvas.height = bitmap.height;
          }
          if (sizeChanged || this.sizeReportedGeneration !== frame.generation) {
            this.sizeReportedGeneration = frame.generation;
            this.onSize({ width: bitmap.width, height: bitmap.height });
          }
          this.canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0);
          this.lastSequence = frame.sequence;
        } finally {
          bitmap.close();
        }
      }
    } finally {
      this.painting = false;
      if (!this.disposed && this.latest) void this.paintLoop();
    }
  }

  private hasNewerQueuedFrame(frame: PendingFrame): boolean {
    const latest = this.latest;
    return latest?.generation === frame.generation && latest.sequence > frame.sequence;
  }
}
