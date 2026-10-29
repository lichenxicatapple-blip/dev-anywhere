import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";

/** Apply an exact scale while preserving the focal point and the library's bounds. */
export function applyImagePreviewTransform(
  transform: ReactZoomPanPinchRef | null,
  x: number,
  y: number,
  scale: number,
  duration = 0,
) {
  const content = transform?.instance.contentComponent;
  const wrapper = transform?.instance.wrapperComponent;
  if (!transform || !content || !wrapper) return;
  // zoomToElement cancels previous animations, including when duration is zero.
  // Unlike the library's zoomIn/zoomOut, it preserves fractional fit scales.
  transform.zoomToElement(
    content,
    scale,
    duration,
    "easeOut",
    x - (wrapper.offsetWidth - content.offsetWidth * scale) / 2,
    y - (wrapper.offsetHeight - content.offsetHeight * scale) / 2,
  );
}
