import { useCallback, useEffect, useRef } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from "react";
import type { Terminal } from "@xterm/xterm";
import { getEdgeAutoscrollDelta } from "@/lib/pty-edge-autoscroll";
import { usePtyTouchGesture } from "./use-pty-touch-gesture";

export type PtySelectionHandleKind = "anchor" | "focus";

interface PtySelectionClientPoint {
  clientX: number;
  clientY: number;
}

interface PointerHandlers {
  onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMoveCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancelCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onTouchStartCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchMoveCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchEndCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchCancelCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void;
}

interface UsePtySelectionGestureDriverOptions {
  terminalRef: RefObject<Terminal | null>;
  containerEl: HTMLDivElement | null;
  suppressPtyFocus: () => void;
  isSelectionActive: () => boolean;
  onTap?: (point: PtySelectionClientPoint) => boolean;
  isTapCandidate?: (point: PtySelectionClientPoint) => boolean;
  onLongPressCandidateStart: (point: PtySelectionClientPoint) => void;
  onLongPressStart: (point: PtySelectionClientPoint) => void;
  onLongPressMove: (point: PtySelectionClientPoint) => void;
  onLongPressEnd: (point: PtySelectionClientPoint) => void;
  onHandleDragStart: (kind: PtySelectionHandleKind) => void;
  onHandleDragMove: (kind: PtySelectionHandleKind, point: PtySelectionClientPoint) => void;
  onHandleDragEnd: (kind: PtySelectionHandleKind, point: PtySelectionClientPoint | null) => void;
  onHandleDragCancel: (kind: PtySelectionHandleKind) => void;
}

interface UsePtySelectionGestureDriverResult {
  pointerHandlers: PointerHandlers;
  stopPtySelectionGesture: () => void;
  handlePtySelectionHandlePointerDown: (
    kind: PtySelectionHandleKind,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  handlePtySelectionHandleTouchStart: (
    kind: PtySelectionHandleKind,
    event: ReactTouchEvent<HTMLElement>,
  ) => void;
}

export function usePtySelectionGestureDriver({
  terminalRef,
  containerEl,
  suppressPtyFocus,
  isSelectionActive,
  onTap,
  isTapCandidate,
  onLongPressCandidateStart,
  onLongPressStart,
  onLongPressMove,
  onLongPressEnd,
  onHandleDragStart,
  onHandleDragMove,
  onHandleDragEnd,
  onHandleDragCancel,
}: UsePtySelectionGestureDriverOptions): UsePtySelectionGestureDriverResult {
  const autoscrollFrameRef = useRef<number | null>(null);
  const autoscrollPointRef = useRef<PtySelectionClientPoint | null>(null);
  const autoscrollApplyRef = useRef<((point: PtySelectionClientPoint) => void) | null>(null);
  const suppressNativeTouchScrollRef = useRef(false);
  const handleDragCleanupRef = useRef<(() => void) | null>(null);

  const stopPtySelectionGesture = useCallback((): void => {
    handleDragCleanupRef.current?.();
    handleDragCleanupRef.current = null;
    autoscrollPointRef.current = null;
    autoscrollApplyRef.current = null;
    suppressNativeTouchScrollRef.current = false;
    if (autoscrollFrameRef.current === null) return;
    cancelAnimationFrame(autoscrollFrameRef.current);
    autoscrollFrameRef.current = null;
  }, []);

  const runPtySelectionAutoscroll = useCallback((): void => {
    autoscrollFrameRef.current = null;
    const point = autoscrollPointRef.current;
    if (!point || !containerEl || !isSelectionActive()) return;

    const rect = containerEl.getBoundingClientRect();
    const { dx, dy } = getEdgeAutoscrollDelta({
      pointerX: point.clientX,
      pointerY: point.clientY,
      rect,
      scrollLeft: containerEl.scrollLeft,
      scrollTop: containerEl.scrollTop,
      scrollWidth: containerEl.scrollWidth,
      scrollHeight: containerEl.scrollHeight,
      clientWidth: containerEl.clientWidth,
      clientHeight: containerEl.clientHeight,
      edgePx: 44,
      maxSpeedPx: 18,
    });

    if (dx !== 0) containerEl.scrollLeft += dx;
    if (dy !== 0) containerEl.scrollTop += dy;
    if (dx !== 0 || dy !== 0) autoscrollApplyRef.current?.(point);

    autoscrollFrameRef.current = requestAnimationFrame(runPtySelectionAutoscroll);
  }, [containerEl, isSelectionActive]);

  const updatePtySelectionAutoscroll = useCallback(
    (point: PtySelectionClientPoint, applyMove: (point: PtySelectionClientPoint) => void): void => {
      autoscrollPointRef.current = point;
      autoscrollApplyRef.current = applyMove;
      if (autoscrollFrameRef.current !== null) return;
      autoscrollFrameRef.current = requestAnimationFrame(runPtySelectionAutoscroll);
    },
    [runPtySelectionAutoscroll],
  );

  useEffect(() => stopPtySelectionGesture, [stopPtySelectionGesture]);

  useEffect(() => {
    if (!containerEl) return;
    const suppressNativeScroll = (event: TouchEvent): void => {
      if (!suppressNativeTouchScrollRef.current) return;
      event.preventDefault();
    };
    containerEl.addEventListener("touchmove", suppressNativeScroll, {
      capture: true,
      passive: false,
    });
    document.addEventListener("touchmove", suppressNativeScroll, {
      capture: true,
      passive: false,
    });
    return () => {
      containerEl.removeEventListener("touchmove", suppressNativeScroll, {
        capture: true,
      });
      document.removeEventListener("touchmove", suppressNativeScroll, {
        capture: true,
      });
    };
  }, [containerEl]);

  const handleLongPressStart = useCallback(
    (point: PtySelectionClientPoint): void => {
      stopPtySelectionGesture();
      suppressNativeTouchScrollRef.current = true;
      onLongPressStart(point);
    },
    [onLongPressStart, stopPtySelectionGesture],
  );

  const handleLongPressMove = useCallback(
    (point: PtySelectionClientPoint): void => {
      onLongPressMove(point);
      updatePtySelectionAutoscroll(point, onLongPressMove);
    },
    [onLongPressMove, updatePtySelectionAutoscroll],
  );

  const handleLongPressEnd = useCallback(
    (point: PtySelectionClientPoint): void => {
      stopPtySelectionGesture();
      onLongPressEnd(point);
    },
    [onLongPressEnd, stopPtySelectionGesture],
  );

  const pointerHandlers = usePtyTouchGesture({
    terminalRef,
    suppressPtyFocus,
    onTap,
    isTapCandidate,
    onLongPressCandidateStart,
    onLongPressStart: handleLongPressStart,
    onLongPressMove: handleLongPressMove,
    onLongPressEnd: handleLongPressEnd,
  });

  const handlePtySelectionHandlePointerDown = useCallback(
    (kind: PtySelectionHandleKind, event: ReactPointerEvent<HTMLElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      stopPtySelectionGesture();
      suppressNativeTouchScrollRef.current = true;
      onHandleDragStart(kind);

      let cleanup = (): void => {};
      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.cancelable) moveEvent.preventDefault();
        const point = { clientX: moveEvent.clientX, clientY: moveEvent.clientY };
        onHandleDragMove(kind, point);
        updatePtySelectionAutoscroll(point, (nextPoint) => onHandleDragMove(kind, nextPoint));
      };
      const finish = (finishEvent: PointerEvent): void => {
        const point = { clientX: finishEvent.clientX, clientY: finishEvent.clientY };
        cleanup();
        handleDragCleanupRef.current = null;
        stopPtySelectionGesture();
        onHandleDragEnd(kind, point);
      };
      const cancel = (): void => {
        cleanup();
        handleDragCleanupRef.current = null;
        stopPtySelectionGesture();
        onHandleDragCancel(kind);
      };
      cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
      };
      handleDragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", finish, { once: true });
      window.addEventListener("pointercancel", cancel, { once: true });
    },
    [
      onHandleDragCancel,
      onHandleDragEnd,
      onHandleDragMove,
      onHandleDragStart,
      stopPtySelectionGesture,
      updatePtySelectionAutoscroll,
    ],
  );

  const handlePtySelectionHandleTouchStart = useCallback(
    (kind: PtySelectionHandleKind, event: ReactTouchEvent<HTMLElement>): void => {
      if (handleDragCleanupRef.current) return;
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) return;
      event.preventDefault();
      event.stopPropagation();
      suppressNativeTouchScrollRef.current = true;
      onHandleDragStart(kind);

      let cleanup = (): void => {};
      const move = (moveEvent: TouchEvent): void => {
        const nextTouch = moveEvent.touches[0] ?? moveEvent.changedTouches[0];
        if (!nextTouch) return;
        if (moveEvent.cancelable) moveEvent.preventDefault();
        const point = { clientX: nextTouch.clientX, clientY: nextTouch.clientY };
        onHandleDragMove(kind, point);
        updatePtySelectionAutoscroll(point, (nextPoint) => onHandleDragMove(kind, nextPoint));
      };
      const finish = (finishEvent: TouchEvent): void => {
        const endTouch = finishEvent.changedTouches[0];
        const point = endTouch
          ? { clientX: endTouch.clientX, clientY: endTouch.clientY }
          : autoscrollPointRef.current;
        cleanup();
        handleDragCleanupRef.current = null;
        stopPtySelectionGesture();
        onHandleDragEnd(kind, point);
      };
      const cancel = (): void => {
        cleanup();
        handleDragCleanupRef.current = null;
        stopPtySelectionGesture();
        onHandleDragCancel(kind);
      };
      cleanup = () => {
        window.removeEventListener("touchmove", move);
        window.removeEventListener("touchend", finish);
        window.removeEventListener("touchcancel", cancel);
      };
      handleDragCleanupRef.current = cleanup;
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", finish, { once: true });
      window.addEventListener("touchcancel", cancel, { once: true });
    },
    [
      onHandleDragCancel,
      onHandleDragEnd,
      onHandleDragMove,
      onHandleDragStart,
      stopPtySelectionGesture,
      updatePtySelectionAutoscroll,
    ],
  );

  return {
    pointerHandlers,
    stopPtySelectionGesture,
    handlePtySelectionHandlePointerDown,
    handlePtySelectionHandleTouchStart,
  };
}
