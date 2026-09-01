export interface DevicePreviewFrameLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
}

export interface NormalizedDevicePoint {
  x: number;
  y: number;
}

/** Maps a browser pointer into an object-fit:contain frame. Letterboxed space is not clickable. */
export function normalizedPointInDeviceFrame(
  clientX: number,
  clientY: number,
  layout: DevicePreviewFrameLayout,
): NormalizedDevicePoint | null {
  const values = [
    clientX,
    clientY,
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
  const renderedWidth = layout.frameWidth * scale;
  const renderedHeight = layout.frameHeight * scale;
  const renderedLeft = layout.left + (layout.width - renderedWidth) / 2;
  const renderedTop = layout.top + (layout.height - renderedHeight) / 2;
  const x = (clientX - renderedLeft) / renderedWidth;
  const y = (clientY - renderedTop) / renderedHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

export type DevicePointerGesture =
  | { kind: "tap"; x: number; y: number }
  | {
      kind: "swipe";
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      durationMs: number;
    };

export function devicePointerGesture(input: {
  start: NormalizedDevicePoint;
  end: NormalizedDevicePoint;
  startClientX: number;
  startClientY: number;
  endClientX: number;
  endClientY: number;
  durationMs: number;
  tapSlopPx?: number;
}): DevicePointerGesture {
  const distance = Math.hypot(
    input.endClientX - input.startClientX,
    input.endClientY - input.startClientY,
  );
  if (distance <= (input.tapSlopPx ?? 8)) {
    return { kind: "tap", x: input.end.x, y: input.end.y };
  }
  return {
    kind: "swipe",
    startX: input.start.x,
    startY: input.start.y,
    endX: input.end.x,
    endY: input.end.y,
    durationMs: Math.min(5_000, Math.max(16, Math.round(input.durationMs))),
  };
}
