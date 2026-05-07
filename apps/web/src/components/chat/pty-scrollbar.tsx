import type { PointerEvent } from "react";
import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { PtyScrollState } from "@/lib/pty-scroll-controller";

interface PtyScrollbarProps {
  state: PtyScrollState;
  onScrollRatio: (ratio: number) => void;
}

interface PtyHorizontalScrollbarProps {
  state: PtyScrollState;
  onScrollRatio: (ratio: number) => void;
}

const MIN_THUMB_HEIGHT = 32;
const MIN_THUMB_WIDTH = 40;

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

export function PtyHorizontalScrollbar({ state, onScrollRatio }: PtyHorizontalScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragThumbOffsetRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const geometry = useMemo(() => {
    if (!state.horizontalScrollable || state.scrollWidth <= 0 || state.clientWidth <= 0) {
      return { visible: false, leftPercent: 0, widthPercent: 100 };
    }
    const widthPercent = Math.max(
      (MIN_THUMB_WIDTH / state.clientWidth) * 100,
      (state.clientWidth / state.scrollWidth) * 100,
    );
    const maxScrollLeft = Math.max(1, state.scrollWidth - state.clientWidth);
    const maxLeftPercent = Math.max(0, 100 - widthPercent);
    const leftPercent = Math.max(
      0,
      Math.min(maxLeftPercent, (state.scrollLeft / maxScrollLeft) * maxLeftPercent),
    );
    return { visible: true, leftPercent, widthPercent };
  }, [state.clientWidth, state.horizontalScrollable, state.scrollLeft, state.scrollWidth]);

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const thumbOffset = dragThumbOffsetRef.current;
    const thumb = thumbRef.current;
    const thumbWidth = thumb?.getBoundingClientRect().width ?? 0;
    const travelWidth = Math.max(1, rect.width - thumbWidth);
    const ratio =
      thumbOffset === null
        ? (event.clientX - rect.left) / rect.width
        : (event.clientX - rect.left - thumbOffset) / travelWidth;
    onScrollRatio(ratio);
  };

  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      data-slot="pty-horizontal-scrollbar"
      className={cn(
        "group absolute left-3 right-10 bottom-0 z-10 h-8 touch-none transition-opacity duration-150",
        geometry.visible ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
      onPointerDown={(event) => {
        draggingRef.current = true;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        const thumb = thumbRef.current;
        const target = event.target;
        const thumbPressed = target instanceof Node && thumb?.contains(target);
        if (thumbPressed && thumb) {
          dragThumbOffsetRef.current = event.clientX - thumb.getBoundingClientRect().left;
          return;
        }
        dragThumbOffsetRef.current = null;
        updateFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        updateFromPointer(event);
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        dragThumbOffsetRef.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        draggingRef.current = false;
        dragThumbOffsetRef.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      <div
        className={cn(
          "absolute left-0 right-0 bottom-2 h-2 rounded-full bg-foreground/5 opacity-0 transition-opacity",
          (dragging || geometry.visible) && "group-hover:opacity-100",
          dragging && "opacity-100",
        )}
      />
      <div
        ref={thumbRef}
        data-slot="pty-horizontal-scrollbar-thumb"
        className={cn(
          "absolute bottom-2 h-2 rounded-full bg-foreground/35 transition-[background-color,height,bottom]",
          "group-hover:bottom-1.5 group-hover:h-2.5 group-hover:bg-foreground/55",
          dragging && "bottom-1.5 h-2.5 bg-foreground/70",
        )}
        style={{
          left: `${geometry.leftPercent}%`,
          width: `${geometry.widthPercent}%`,
        }}
      />
    </div>
  );
}
