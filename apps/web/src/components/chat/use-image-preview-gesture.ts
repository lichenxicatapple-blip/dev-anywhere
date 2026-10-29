import { useEffect, type RefObject } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";

type SafariGestureEvent = Event & {
  scale: number;
  clientX?: number;
  clientY?: number;
};

/** Safari trackpads emit gesture events, which the zoom library does not handle. */
export function useImagePreviewGesture({
  stageRef,
  transformRef,
  enabled,
  minScale,
  maxScale,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  transformRef: RefObject<ReactZoomPanPinchRef | null>;
  enabled: boolean;
  minScale: number;
  maxScale: number;
}) {
  useEffect(() => {
    const stage = stageRef.current;
    if (!enabled || !stage) return;

    let touches = 0;
    let owner: "touch" | "trackpad" | null = null;
    let start: {
      scale: number;
      gestureScale: number;
      x: number;
      y: number;
      imageX: number;
      imageY: number;
    } | null = null;

    const onTouch = (event: TouchEvent) => {
      touches = Array.from(event.touches).filter(
        (touch) => touch.target instanceof Node && stage.contains(touch.target),
      ).length;
      if (touches > 0 && owner === "trackpad") {
        owner = "touch";
        start = null;
      }
    };
    const applyTransform = (x: number, y: number, scale: number) => {
      const transform = transformRef.current;
      const content = transform?.instance.contentComponent;
      const wrapper = transform?.instance.wrapperComponent;
      if (!transform || !content || !wrapper) return;
      // zoomToElement cancels any running reset/pan animation and enforces the
      // library's bounds. Offset its default centering to preserve our focal point.
      // setTransform(..., 0) alone would let the old animation overwrite the pinch.
      transform.zoomToElement(
        content,
        scale,
        0,
        "easeOut",
        x - (wrapper.offsetWidth - content.offsetWidth * scale) / 2,
        y - (wrapper.offsetHeight - content.offsetHeight * scale) / 2,
      );
    };
    const onStart = (event: Event) => {
      const transform = transformRef.current;
      const wrapper = transform?.instance.wrapperComponent;
      if (!transform || !wrapper) return;
      event.preventDefault();
      // iOS also emits gesture events for screen touches. Leave their zoom to the
      // library's touch handlers so the same pinch is never applied twice.
      owner = touches > 0 ? "touch" : "trackpad";
      start = null;
      if (owner === "touch") return;

      const gesture = event as SafariGestureEvent;
      if (!Number.isFinite(gesture.scale) || gesture.scale <= 0) return;
      applyTransform(transform.state.positionX, transform.state.positionY, transform.state.scale);
      const { scale, positionX, positionY } = transform.state;
      const rect = wrapper.getBoundingClientRect();
      const x =
        gesture.clientX === undefined ? wrapper.clientWidth / 2 : gesture.clientX - rect.left;
      const y =
        gesture.clientY === undefined ? wrapper.clientHeight / 2 : gesture.clientY - rect.top;
      start = {
        scale,
        gestureScale: gesture.scale,
        x,
        y,
        imageX: (x - positionX) / scale,
        imageY: (y - positionY) / scale,
      };
    };
    const onChange = (event: Event) => {
      if (!owner) return;
      event.preventDefault();
      if (owner !== "trackpad" || !start) return;
      const { scale: gestureScale } = event as SafariGestureEvent;
      if (!Number.isFinite(gestureScale) || gestureScale <= 0) return;
      const scale = Math.min(
        maxScale,
        Math.max(minScale, (start.scale * gestureScale) / start.gestureScale),
      );
      applyTransform(start.x - start.imageX * scale, start.y - start.imageY * scale, scale);
    };
    const onEnd = (event: Event) => {
      if (owner) event.preventDefault();
      owner = null;
      start = null;
    };
    const onWheel = (event: WheelEvent) => {
      if (owner !== "trackpad" || !event.ctrlKey) return;
      // If a browser emits both representations, only the gesture owns this pinch.
      event.preventDefault();
      event.stopPropagation();
    };
    const options = { passive: false, capture: true };
    stage.addEventListener("gesturestart", onStart, options);
    stage.addEventListener("gesturechange", onChange, options);
    stage.addEventListener("gestureend", onEnd, options);
    stage.addEventListener("wheel", onWheel, options);
    for (const type of ["touchstart", "touchend", "touchcancel"] as const) {
      stage.addEventListener(type, onTouch, { passive: true, capture: true });
    }
    return () => {
      stage.removeEventListener("gesturestart", onStart, options);
      stage.removeEventListener("gesturechange", onChange, options);
      stage.removeEventListener("gestureend", onEnd, options);
      stage.removeEventListener("wheel", onWheel, options);
      for (const type of ["touchstart", "touchend", "touchcancel"] as const) {
        stage.removeEventListener(type, onTouch, true);
      }
    };
  }, [enabled, minScale, maxScale, stageRef, transformRef]);
}
