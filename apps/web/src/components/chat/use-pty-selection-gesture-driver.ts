import { useCallback, useEffect, useRef } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from "react";
import type { Terminal } from "@xterm/xterm";
import { getEdgeAutoscrollDelta } from "@/lib/pty-edge-autoscroll";
import {
  usePtyTouchGesture,
  type PtyTouchGestureFinishKind,
  type PtyTouchGestureScrollPosition,
} from "./use-pty-touch-gesture";

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
  suppressPtyFocus: (options?: { blur?: boolean }) => void;
  focusPtyInput?: () => void;
  isSelectionActive: () => boolean;
  isGestureTarget?: (point: PtySelectionClientPoint) => boolean;
  onTap?: (point: PtySelectionClientPoint) => boolean;
  isTapCandidate?: (point: PtySelectionClientPoint) => boolean;
  onLongPressCandidateStart: (point: PtySelectionClientPoint) => void;
  onLongPressStart: (point: PtySelectionClientPoint) => void;
  onLongPressMove: (point: PtySelectionClientPoint) => boolean;
  onLongPressEnd: (point: PtySelectionClientPoint) => void;
  onGestureFinish?: (kind: PtyTouchGestureFinishKind) => void;
  getTouchScrollPosition?: () => PtyTouchGestureScrollPosition | null;
  onVerticalScrollIntent?: (reason: string) => void;
  onHorizontalScrollIntent?: (reason: string) => void;
  onSelectionAutoscroll?: (position: { scrollLeft: number; scrollTop: number }) => void;
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
  focusPtyInput,
  isSelectionActive,
  isGestureTarget,
  onTap,
  isTapCandidate,
  onLongPressCandidateStart,
  onLongPressStart,
  onLongPressMove,
  onLongPressEnd,
  onGestureFinish,
  getTouchScrollPosition,
  onVerticalScrollIntent,
  onHorizontalScrollIntent,
  onSelectionAutoscroll,
  onHandleDragStart,
  onHandleDragMove,
  onHandleDragEnd,
  onHandleDragCancel,
}: UsePtySelectionGestureDriverOptions): UsePtySelectionGestureDriverResult {
  const autoscrollFrameRef = useRef<number | null>(null);
  const autoscrollPointRef = useRef<PtySelectionClientPoint | null>(null);
  const autoscrollApplyRef = useRef<((point: PtySelectionClientPoint) => void) | null>(null);
  const verticalScrollIntentMarkedRef = useRef(false);
  const suppressNativeTouchScrollRef = useRef(false);
  const handleDragCleanupRef = useRef<(() => void) | null>(null);
  const handleDragCancelRef = useRef<(() => void) | null>(null);

  const stopPtySelectionAutoscroll = useCallback((): void => {
    autoscrollPointRef.current = null;
    autoscrollApplyRef.current = null;
    verticalScrollIntentMarkedRef.current = false;
    if (autoscrollFrameRef.current === null) return;
    cancelAnimationFrame(autoscrollFrameRef.current);
    autoscrollFrameRef.current = null;
  }, []);

  const stopPtySelectionGesture = useCallback((): void => {
    handleDragCleanupRef.current?.();
    handleDragCleanupRef.current = null;
    handleDragCancelRef.current = null;
    suppressNativeTouchScrollRef.current = false;
    stopPtySelectionAutoscroll();
  }, [stopPtySelectionAutoscroll]);

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

    if (dx !== 0) {
      onHorizontalScrollIntent?.(`selectionGestureAutoscroll dx=${Math.round(dx)}`);
      containerEl.scrollLeft += dx;
    }
    if (dy !== 0) {
      if (!verticalScrollIntentMarkedRef.current) {
        onVerticalScrollIntent?.(`selectionGestureAutoscroll dy=${Math.round(dy)}`);
        verticalScrollIntentMarkedRef.current = true;
      }
      containerEl.scrollTop += dy;
    }
    if (dx !== 0 || dy !== 0) {
      onSelectionAutoscroll?.({
        scrollLeft: containerEl.scrollLeft,
        scrollTop: containerEl.scrollTop,
      });
      autoscrollApplyRef.current?.(point);
    }

    autoscrollFrameRef.current = requestAnimationFrame(runPtySelectionAutoscroll);
  }, [
    containerEl,
    isSelectionActive,
    onHorizontalScrollIntent,
    onSelectionAutoscroll,
    onVerticalScrollIntent,
  ]);

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
    const interruptGesture = (): void => {
      const cancelHandleDrag = handleDragCancelRef.current;
      if (cancelHandleDrag) cancelHandleDrag();
      else stopPtySelectionGesture();
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") interruptGesture();
    };

    window.addEventListener("blur", interruptGesture);
    window.addEventListener("pagehide", interruptGesture);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", interruptGesture);
      window.removeEventListener("pagehide", interruptGesture);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [stopPtySelectionGesture]);

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
      if (!onLongPressMove(point)) {
        stopPtySelectionAutoscroll();
        return;
      }
      updatePtySelectionAutoscroll(point, onLongPressMove);
    },
    [onLongPressMove, stopPtySelectionAutoscroll, updatePtySelectionAutoscroll],
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
    focusTerminal: focusPtyInput,
    isGestureTarget,
    onTap,
    isTapCandidate,
    onLongPressCandidateStart,
    onLongPressStart: handleLongPressStart,
    onLongPressMove: handleLongPressMove,
    onLongPressEnd: handleLongPressEnd,
    onGestureFinish,
    getScrollPosition: getTouchScrollPosition,
  });

  const handlePtySelectionHandlePointerDown = useCallback(
    (kind: PtySelectionHandleKind, event: ReactPointerEvent<HTMLElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      if (handleDragCleanupRef.current) return;
      stopPtySelectionGesture();
      suppressNativeTouchScrollRef.current = true;
      onHandleDragStart(kind);

      const pointerId = event.pointerId;
      const handleRect = event.currentTarget.getBoundingClientRect();
      const grabOffset = {
        x: event.clientX - (handleRect.left + handleRect.width / 2),
        y: event.clientY - (handleRect.top + handleRect.height / 2),
      };
      const getEndpointPoint = (clientX: number, clientY: number): PtySelectionClientPoint => ({
        clientX: clientX - grabOffset.x,
        clientY: clientY - grabOffset.y,
      });

      let cleanup = (): void => {};
      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        if (moveEvent.cancelable) moveEvent.preventDefault();
        const point = getEndpointPoint(moveEvent.clientX, moveEvent.clientY);
        onHandleDragMove(kind, point);
        updatePtySelectionAutoscroll(point, (nextPoint) => onHandleDragMove(kind, nextPoint));
      };
      const finish = (finishEvent: PointerEvent): void => {
        if (finishEvent.pointerId !== pointerId) return;
        const point = getEndpointPoint(finishEvent.clientX, finishEvent.clientY);
        cleanup();
        handleDragCleanupRef.current = null;
        stopPtySelectionGesture();
        onHandleDragEnd(kind, point);
      };
      const cancel = (cancelEvent: PointerEvent): void => {
        if (cancelEvent.pointerId !== pointerId) return;
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
      handleDragCancelRef.current = () => {
        stopPtySelectionGesture();
        onHandleDragCancel(kind);
      };
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
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
      verticalScrollIntentMarkedRef.current = false;
      onHandleDragStart(kind);

      const touchId = touch.identifier;
      const handleRect = event.currentTarget.getBoundingClientRect();
      const grabOffset = {
        x: touch.clientX - (handleRect.left + handleRect.width / 2),
        y: touch.clientY - (handleRect.top + handleRect.height / 2),
      };
      const findTouch = (touches: TouchList): Touch | null => {
        for (let index = 0; index < touches.length; index += 1) {
          const candidate = touches[index];
          if (candidate?.identifier === touchId) return candidate;
        }
        return null;
      };
      const getEndpointPoint = (clientX: number, clientY: number): PtySelectionClientPoint => ({
        clientX: clientX - grabOffset.x,
        clientY: clientY - grabOffset.y,
      });

      let cleanup = (): void => {};
      const move = (moveEvent: TouchEvent): void => {
        const nextTouch = findTouch(moveEvent.touches) ?? findTouch(moveEvent.changedTouches);
        if (!nextTouch) return;
        if (moveEvent.cancelable) moveEvent.preventDefault();
        const point = getEndpointPoint(nextTouch.clientX, nextTouch.clientY);
        onHandleDragMove(kind, point);
        updatePtySelectionAutoscroll(point, (nextPoint) => onHandleDragMove(kind, nextPoint));
      };
      const finish = (finishEvent: TouchEvent): void => {
        const endTouch = findTouch(finishEvent.changedTouches);
        if (!endTouch) return;
        const point = endTouch
          ? getEndpointPoint(endTouch.clientX, endTouch.clientY)
          : autoscrollPointRef.current;
        cleanup();
        handleDragCleanupRef.current = null;
        stopPtySelectionGesture();
        onHandleDragEnd(kind, point);
      };
      const cancel = (cancelEvent: TouchEvent): void => {
        if (!findTouch(cancelEvent.changedTouches)) return;
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
      handleDragCancelRef.current = () => {
        stopPtySelectionGesture();
        onHandleDragCancel(kind);
      };
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", finish);
      window.addEventListener("touchcancel", cancel);
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
