import type { PointerEvent } from "react";
import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { PtyScrollState } from "@/lib/pty-scroll-controller";

interface PtyScrollbarProps {
  state: PtyScrollState;
  onScrollRatio: (ratio: number) => void;
}

const MIN_THUMB_HEIGHT = 32;

export function PtyScrollbar({ state, onScrollRatio }: PtyScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const geometry = useMemo(() => {
    if (!state.scrollable || state.scrollHeight <= 0 || state.clientHeight <= 0) {
      return { visible: false, topPercent: 0, heightPercent: 100 };
    }
    const heightPercent = Math.max(
      (MIN_THUMB_HEIGHT / state.clientHeight) * 100,
      (state.clientHeight / state.scrollHeight) * 100,
    );
    const maxScrollTop = Math.max(1, state.scrollHeight - state.clientHeight);
    const maxTopPercent = Math.max(0, 100 - heightPercent);
    const topPercent = Math.max(
      0,
      Math.min(maxTopPercent, (state.scrollTop / maxScrollTop) * maxTopPercent),
    );
    return { visible: true, topPercent, heightPercent };
  }, [state.clientHeight, state.scrollHeight, state.scrollTop, state.scrollable]);

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = (event.clientY - rect.top) / rect.height;
    onScrollRatio(ratio);
  };

  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      data-slot="pty-scrollbar"
      className={cn(
        "group absolute right-0 top-2 bottom-2 z-10 w-8 touch-none transition-opacity duration-150",
        geometry.visible ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
      onPointerDown={(event) => {
        draggingRef.current = true;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        updateFromPointer(event);
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        draggingRef.current = false;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      <div
        className={cn(
          "absolute top-0 right-2 bottom-0 w-2 rounded-full bg-foreground/5 opacity-0 transition-opacity",
          (dragging || geometry.visible) && "group-hover:opacity-100",
          dragging && "opacity-100",
        )}
      />
      <div
        data-slot="pty-scrollbar-thumb"
        className={cn(
          "absolute right-2 w-2 rounded-full bg-foreground/35 transition-[background-color,width,right]",
          "group-hover:right-1.5 group-hover:w-2.5 group-hover:bg-foreground/55",
          dragging && "right-1.5 w-2.5 bg-foreground/70",
        )}
        style={{
          top: `${geometry.topPercent}%`,
          height: `${geometry.heightPercent}%`,
        }}
      />
    </div>
  );
}
