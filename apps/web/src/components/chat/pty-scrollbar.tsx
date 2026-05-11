import type { PointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
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
// 滚动停止后保持滚动条可见的时间, 给用户 0.9s 时间识别位置后渐隐 (macOS overlay 节奏)。
const SCROLL_ACTIVITY_HIDE_DELAY_MS = 900;

// 滚动活动状态: 任意维度 scroll* 数值变化即视为活跃, 停止后 SCROLL_ACTIVITY_HIDE_DELAY_MS 内仍可见。
function useScrollActivity(deps: ReadonlyArray<number>): boolean {
  const [active, setActive] = useState(false);
  const timerRef = useRef<number | null>(null);
  const isFirstRunRef = useRef(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    // 首次挂载或初始 deps 不算用户滚动行为, 否则会让滚动条莫名闪一下
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false;
      return;
    }
    setActive(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setActive(false);
    }, SCROLL_ACTIVITY_HIDE_DELAY_MS);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, deps);
  return active;
}

export function PtyScrollbar({ state, onScrollRatio }: PtyScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragThumbOffsetRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);
  const scrolling = useScrollActivity([state.scrollTop, state.scrollHeight, state.clientHeight]);
  const reveal = scrolling || hovering || dragging;
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
    const thumbOffset = dragThumbOffsetRef.current;
    const thumb = thumbRef.current;
    const thumbHeight = thumb?.getBoundingClientRect().height ?? 0;
    const travelHeight = Math.max(1, rect.height - thumbHeight);
    const ratio =
      thumbOffset === null
        ? (event.clientY - rect.top) / rect.height
        : (event.clientY - rect.top - thumbOffset) / travelHeight;
    onScrollRatio(ratio);
  };

  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      data-slot="pty-scrollbar"
      className={cn(
        "group absolute right-0 top-2 bottom-2 z-10 w-8 touch-none transition-opacity duration-200",
        geometry.visible && reveal ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
      onPointerDown={(event) => {
        draggingRef.current = true;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        const thumb = thumbRef.current;
        const target = event.target;
        const thumbPressed = target instanceof Node && thumb?.contains(target);
        if (thumbPressed && thumb) {
          dragThumbOffsetRef.current = event.clientY - thumb.getBoundingClientRect().top;
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
          "dev-render-scrollbar-track absolute top-0 right-2 bottom-0 w-2 rounded-full opacity-0 transition-opacity",
          (dragging || geometry.visible) && "group-hover:opacity-100",
          dragging && "opacity-100",
        )}
      />
      <div
        ref={thumbRef}
        data-slot="pty-scrollbar-thumb"
        className={cn(
          "dev-render-scrollbar-thumb absolute right-2 w-2 rounded-full transition-[background,width,right,border-color,box-shadow]",
          "group-hover:right-1.5 group-hover:w-2.5",
          dragging && "dev-render-scrollbar-thumb-active right-1.5 w-2.5",
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
          "dev-render-scrollbar-track absolute left-0 right-0 bottom-2 h-2 rounded-full opacity-0 transition-opacity",
          (dragging || geometry.visible) && "group-hover:opacity-100",
          dragging && "opacity-100",
        )}
      />
      <div
        ref={thumbRef}
        data-slot="pty-horizontal-scrollbar-thumb"
        className={cn(
          "dev-render-scrollbar-thumb absolute bottom-2 h-2 rounded-full transition-[background,height,bottom,border-color,box-shadow]",
          "group-hover:bottom-1.5 group-hover:h-2.5",
          dragging && "dev-render-scrollbar-thumb-active bottom-1.5 h-2.5",
        )}
        style={{
          left: `${geometry.leftPercent}%`,
          width: `${geometry.widthPercent}%`,
        }}
      />
    </div>
  );
}
