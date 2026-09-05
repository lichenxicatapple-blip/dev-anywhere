import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { ProxyStatusDot } from "./proxy-status-dot";

const ACTION_WIDTH_PX = 80;
const DIRECTION_LOCK_PX = 8;
const HORIZONTAL_DOMINANCE = 1.2;

type DragAxis = "pending" | "horizontal" | "vertical";

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: number;
  axis: DragAxis;
}

interface SwipeableOfflineProxyRowProps {
  proxyId: string;
  name?: string;
  selected: boolean;
  revealed: boolean;
  disabled?: boolean;
  onRevealedChange: (revealed: boolean) => void;
  onRemove: () => void;
}

function clampOffset(value: number): number {
  return Math.max(0, Math.min(ACTION_WIDTH_PX, value));
}

export function SwipeableOfflineProxyRow({
  proxyId,
  name,
  selected,
  revealed,
  disabled = false,
  onRevealedChange,
  onRemove,
}: SwipeableOfflineProxyRowProps) {
  const displayName = name ?? proxyId;
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const effectiveOffset = dragOffset ?? (revealed ? ACTION_WIDTH_PX : 0);
  const dragging = dragOffset !== null;

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (disabled || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
    if ((event.target as Element).closest("button")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: revealed ? ACTION_WIDTH_PX : 0,
      axis: "pending",
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic browser tests and older WebViews may expose the method without an active pointer.
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (drag.axis === "pending") {
      if (Math.hypot(dx, dy) < DIRECTION_LOCK_PX) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_DOMINANCE ? "horizontal" : "vertical";
    }
    if (drag.axis === "vertical") return;

    event.preventDefault();
    setDragOffset(clampOffset(drag.startOffset - dx));
  }

  function finishDrag(event: React.PointerEvent<HTMLDivElement>, cancelled = false): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // The pointer can already be released when the browser turns the gesture into a scroll.
    }

    if (drag.axis !== "horizontal" || cancelled) {
      setDragOffset(null);
      return;
    }

    event.preventDefault();
    const finalOffset = dragOffset ?? clampOffset(drag.startOffset - (event.clientX - drag.startX));
    setDragOffset(null);
    onRevealedChange(finalOffset >= ACTION_WIDTH_PX / 2);
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }

  function handleForegroundClick(event: React.MouseEvent<HTMLDivElement>): void {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      return;
    }
    if (revealed) onRevealedChange(false);
  }

  return (
    <li
      className="relative h-11 overflow-hidden rounded-md border border-border bg-card"
      data-slot="proxy-item"
      data-swipeable="true"
      data-proxy-id={proxyId}
      data-online="false"
      data-revealed={revealed || undefined}
    >
      <div
        className="relative z-10 flex h-full w-full touch-pan-y select-none items-center gap-3 bg-card px-3 text-left text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{
          transform: `translateX(-${effectiveOffset}px)`,
          transitionDuration: dragging ? "0ms" : undefined,
        }}
        title="这台开发机离线。向左滑动可移除。"
        data-slot="proxy-swipe-foreground"
        data-offset={effectiveOffset}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishDrag(event)}
        onPointerCancel={(event) => finishDrag(event, true)}
        onClick={handleForegroundClick}
      >
        <ProxyStatusDot status="offline" />
        <span className="min-w-0 flex-1 truncate text-sm font-normal">{displayName}</span>
        {selected && <Check className="size-4 shrink-0 text-primary" aria-label="已选" />}
        <span className="shrink-0 text-xs">离线</span>
      </div>
      <button
        type="button"
        className={`absolute inset-y-0 right-0 z-0 flex w-20 items-center justify-center bg-destructive text-sm font-medium text-white outline-none transition-colors hover:bg-destructive/90 focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 ${revealed ? "" : "pointer-events-none"}`}
        tabIndex={revealed ? 0 : -1}
        disabled={disabled}
        aria-label={`移除 ${displayName}`}
        aria-hidden={revealed ? undefined : true}
        data-slot="proxy-mobile-remove"
        onClick={onRemove}
      >
        移除
      </button>
    </li>
  );
}
