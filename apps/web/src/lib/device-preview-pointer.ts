interface DevicePreviewFrameLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
}

interface NormalizedDevicePoint {
  x: number;
  y: number;
}

interface RenderedDeviceFrame {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function renderedDeviceFrame(layout: DevicePreviewFrameLayout): RenderedDeviceFrame | null {
  const values = [
    layout.left,
    layout.top,
    layout.width,
    layout.height,
    layout.frameWidth,
    layout.frameHeight,
  ];
  if (values.some((value) => !Number.isFinite(value))) return null;
  if (
    layout.width <= 0 ||
    layout.height <= 0 ||
    layout.frameWidth <= 0 ||
    layout.frameHeight <= 0
  ) {
    return null;
  }

  const scale = Math.min(layout.width / layout.frameWidth, layout.height / layout.frameHeight);
  const width = layout.frameWidth * scale;
  const height = layout.frameHeight * scale;
  const left = layout.left + (layout.width - width) / 2;
  const top = layout.top + (layout.height - height) / 2;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function pointInRenderedFrame(
  clientX: number,
  clientY: number,
  frame: RenderedDeviceFrame,
): NormalizedDevicePoint {
  return {
    x: Math.min(1, Math.max(0, (clientX - frame.left) / frame.width)),
    y: Math.min(1, Math.max(0, (clientY - frame.top) / frame.height)),
  };
}

/** Maps a browser pointer into an object-fit:contain frame. Letterboxed space is not clickable. */
export function normalizedPointInDeviceFrame(
  clientX: number,
  clientY: number,
  layout: DevicePreviewFrameLayout,
): NormalizedDevicePoint | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const frame = renderedDeviceFrame(layout);
  if (!frame) return null;
  if (
    clientX < frame.left ||
    clientX > frame.right ||
    clientY < frame.top ||
    clientY > frame.bottom
  ) {
    return null;
  }
  return pointInRenderedFrame(clientX, clientY, frame);
}

/** Maps an already-captured pointer back onto the nearest screen coordinate. */
export function clampedPointInDeviceFrame(
  clientX: number,
  clientY: number,
  layout: DevicePreviewFrameLayout,
): NormalizedDevicePoint | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const frame = renderedDeviceFrame(layout);
  return frame ? pointInRenderedFrame(clientX, clientY, frame) : null;
}
