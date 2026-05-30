interface EdgeAutoscrollRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface EdgeAutoscrollOptions {
  pointerX: number;
  pointerY: number;
  rect: EdgeAutoscrollRect;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  edgePx?: number;
  maxSpeedPx?: number;
}

interface EdgeAutoscrollDelta {
  dx: number;
  dy: number;
}

export const DEFAULT_EDGE_AUTOSCROLL_PX = 28;
export const DEFAULT_EDGE_AUTOSCROLL_MAX_SPEED_PX = 14;

function edgeSpeed(distanceToEdge: number, edgePx: number, maxSpeedPx: number): number {
  const factor = Math.min(1, Math.max(0, 1 - distanceToEdge / edgePx));
  return Math.ceil(maxSpeedPx * factor);
}

export function getEdgeAutoscrollDelta({
  pointerX,
  pointerY,
  rect,
  scrollLeft,
  scrollTop,
  scrollWidth,
  scrollHeight,
  clientWidth,
  clientHeight,
  edgePx = DEFAULT_EDGE_AUTOSCROLL_PX,
  maxSpeedPx = DEFAULT_EDGE_AUTOSCROLL_MAX_SPEED_PX,
}: EdgeAutoscrollOptions): EdgeAutoscrollDelta {
  let dx = 0;
  const distLeft = pointerX - rect.left;
  const distRight = rect.right - pointerX;
  if (distLeft < edgePx && scrollLeft > 0) {
    dx = -edgeSpeed(distLeft, edgePx, maxSpeedPx);
  } else if (distRight < edgePx) {
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
    if (scrollLeft < maxScrollLeft) {
      dx = edgeSpeed(distRight, edgePx, maxSpeedPx);
    }
  }

  let dy = 0;
  const distTop = pointerY - rect.top;
  const distBottom = rect.bottom - pointerY;
  if (distTop < edgePx && scrollTop > 0) {
    dy = -edgeSpeed(distTop, edgePx, maxSpeedPx);
  } else if (distBottom < edgePx) {
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    if (scrollTop < maxScrollTop) {
      dy = edgeSpeed(distBottom, edgePx, maxSpeedPx);
    }
  }

  return { dx, dy };
}
