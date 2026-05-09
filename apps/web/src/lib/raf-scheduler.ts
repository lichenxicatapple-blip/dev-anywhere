export interface RafScheduler {
  schedule: () => void;
  dispose: () => void;
}

export function createRafScheduler(callback: () => void): RafScheduler {
  let frame: number | null = null;
  let disposed = false;

  const run = (): void => {
    frame = null;
    if (!disposed) callback();
  };

  return {
    schedule: () => {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(run);
    },
    dispose: () => {
      disposed = true;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    },
  };
}
