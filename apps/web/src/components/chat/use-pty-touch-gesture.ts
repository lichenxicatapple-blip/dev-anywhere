import type { MouseEvent, PointerEvent, RefObject, TouchEvent } from "react";
import { useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";

// PTY 视图触屏手势：移动 8px 内视为 tap，让 xterm 取焦点；超过阈值视为 swipe，
// 抑制 xterm 自动取焦避免页面滚动时键盘被弹出。pointerId 锁定单指防止
// 多指触摸误判。Terminal 实例和 suppressFocus 由调用方持有。

interface TouchGestureState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  longPressed: boolean;
  longPressDelivered: boolean;
  touchEventStream: boolean;
  longPressTimer: number | null;
}

const TAP_MOVE_THRESHOLD_PX = 8;
const LONG_PRESS_DELAY_MS = 425;
const TOUCH_EVENT_POINTER_ID = -1;
type GestureFinishKind = "tap" | "link" | "scroll" | "longpress";

interface PtyTouchGestureHandlers {
  onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMoveCapture: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancelCapture: (event: PointerEvent<HTMLDivElement>) => void;
  onTouchStartCapture: (event: TouchEvent<HTMLDivElement>) => void;
  onTouchMoveCapture: (event: TouchEvent<HTMLDivElement>) => void;
  onTouchEndCapture: (event: TouchEvent<HTMLDivElement>) => void;
  onTouchCancelCapture: (event: TouchEvent<HTMLDivElement>) => void;
  onContextMenuCapture: (event: MouseEvent<HTMLDivElement>) => void;
}

function matchesGesturePointer(gesture: TouchGestureState, pointerId: number): boolean {
  return gesture.pointerId === pointerId || pointerId === TOUCH_EVENT_POINTER_ID;
}

interface UsePtyTouchGestureOptions {
  terminalRef: RefObject<Terminal | null>;
  suppressPtyFocus: () => void;
  onLongPressCandidateStart?: (point: { clientX: number; clientY: number }) => void;
  onTap?: (point: { clientX: number; clientY: number }) => boolean;
  onLongPressStart?: (point: { clientX: number; clientY: number }) => void;
  onLongPressMove?: (point: { clientX: number; clientY: number }) => void;
  onLongPressEnd?: (point: { clientX: number; clientY: number }) => void;
}

export function usePtyTouchGesture({
  terminalRef,
  suppressPtyFocus,
  onLongPressCandidateStart,
  onTap,
  onLongPressStart,
  onLongPressMove,
  onLongPressEnd,
}: UsePtyTouchGestureOptions): PtyTouchGestureHandlers {
  const touchPointerRef = useRef<TouchGestureState | null>(null);

  const clearLongPressTimer = useCallback((gesture: TouchGestureState): void => {
    if (gesture.longPressTimer === null) return;
    window.clearTimeout(gesture.longPressTimer);
    gesture.longPressTimer = null;
  }, []);

  const markLongPress = useCallback(
    (gesture: TouchGestureState): void => {
      if (gesture.longPressed || gesture.moved) return;
      gesture.longPressed = true;
      clearLongPressTimer(gesture);
      suppressPtyFocus();
      onLongPressStart?.({ clientX: gesture.startX, clientY: gesture.startY });
    },
    [clearLongPressTimer, onLongPressStart, suppressPtyFocus],
  );

  const deliverLongPress = useCallback(
    (gesture: TouchGestureState): void => {
      if (gesture.longPressDelivered || !gesture.longPressed || gesture.moved) return;
      gesture.longPressDelivered = true;
      const point = { clientX: gesture.lastX, clientY: gesture.lastY };
      window.setTimeout(() => onLongPressEnd?.(point), 0);
    },
    [onLongPressEnd],
  );

  const startGesture = useCallback(
    (pointerId: number, clientX: number, clientY: number, touchEventStream = false): void => {
      const gesture: TouchGestureState = {
        pointerId,
        startX: clientX,
        startY: clientY,
        lastX: clientX,
        lastY: clientY,
        moved: false,
        longPressed: false,
        longPressDelivered: false,
        touchEventStream,
        longPressTimer: null,
      };
      gesture.longPressTimer = window.setTimeout(() => {
        if (touchPointerRef.current !== gesture) return;
        markLongPress(gesture);
      }, LONG_PRESS_DELAY_MS);
      touchPointerRef.current = gesture;
      onLongPressCandidateStart?.({ clientX, clientY });
    },
    [markLongPress, onLongPressCandidateStart],
  );

  const updateGestureMove = useCallback(
    (pointerId: number, clientX: number, clientY: number): boolean => {
      const gesture = touchPointerRef.current;
      if (!gesture || !matchesGesturePointer(gesture, pointerId)) return false;
      gesture.lastX = clientX;
      gesture.lastY = clientY;
      if (gesture.longPressed) {
        onLongPressMove?.({ clientX, clientY });
        return true;
      }
      const dx = clientX - gesture.startX;
      const dy = clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) >= TAP_MOVE_THRESHOLD_PX) {
        gesture.moved = true;
        clearLongPressTimer(gesture);
      }
      return gesture.moved;
    },
    [clearLongPressTimer, onLongPressMove],
  );

  const finishGesture = useCallback(
    (pointerId: number, point?: { clientX: number; clientY: number }): GestureFinishKind | null => {
      const gesture = touchPointerRef.current;
      if (!gesture || !matchesGesturePointer(gesture, pointerId)) return null;
      if (point) {
        gesture.lastX = point.clientX;
        gesture.lastY = point.clientY;
      }
      touchPointerRef.current = null;
      clearLongPressTimer(gesture);
      if (gesture.longPressed) {
        deliverLongPress(gesture);
        return "longpress";
      }
      if (gesture.moved) {
        suppressPtyFocus();
        return "scroll";
      }
      if (point && onTap?.(point)) {
        suppressPtyFocus();
        return "link";
      }
      terminalRef.current?.focus();
      return "tap";
    },
    [clearLongPressTimer, deliverLongPress, onTap, suppressPtyFocus, terminalRef],
  );

  const cancelGesture = useCallback(
    (pointerId: number): GestureFinishKind | null => {
      const gesture = touchPointerRef.current;
      if (!gesture || !matchesGesturePointer(gesture, pointerId)) return null;
      clearLongPressTimer(gesture);
      touchPointerRef.current = null;
      if (gesture.longPressed) {
        deliverLongPress(gesture);
        return "longpress";
      }
      suppressPtyFocus();
      return "scroll";
    },
    [clearLongPressTimer, deliverLongPress, suppressPtyFocus],
  );

  const onPointerDownCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (event.pointerType !== "touch") return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".xterm")) return;

      startGesture(event.pointerId, event.clientX, event.clientY);
      event.stopPropagation();
    },
    [startGesture],
  );

  const onPointerMoveCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (!updateGestureMove(event.pointerId, event.clientX, event.clientY)) return;
      event.stopPropagation();
      if (touchPointerRef.current?.longPressed) event.preventDefault();
    },
    [updateGestureMove],
  );

  const onPointerUpCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const result = finishGesture(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (result) {
        event.stopPropagation();
        if (result === "link" && event.cancelable) event.preventDefault();
      }
    },
    [finishGesture],
  );

  const onPointerCancelCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const gesture = touchPointerRef.current;
      if (
        event.pointerType === "touch" &&
        gesture &&
        matchesGesturePointer(gesture, event.pointerId) &&
        gesture.touchEventStream &&
        !gesture.longPressed
      ) {
        event.stopPropagation();
        return;
      }
      if (cancelGesture(event.pointerId)) event.stopPropagation();
    },
    [cancelGesture],
  );

  const onTouchStartCapture = useCallback(
    (event: TouchEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".xterm")) return;
      if (touchPointerRef.current) {
        touchPointerRef.current.touchEventStream = true;
        return;
      }
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) return;
      startGesture(TOUCH_EVENT_POINTER_ID, touch.clientX, touch.clientY, true);
    },
    [startGesture],
  );

  const onTouchMoveCapture = useCallback(
    (event: TouchEvent<HTMLDivElement>): void => {
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) return;
      if (updateGestureMove(TOUCH_EVENT_POINTER_ID, touch.clientX, touch.clientY)) {
        if (touchPointerRef.current?.longPressed) {
          event.stopPropagation();
          event.preventDefault();
        }
      }
    },
    [updateGestureMove],
  );

  const onTouchEndCapture = useCallback(
    (event: TouchEvent<HTMLDivElement>): void => {
      const touch = event.changedTouches[0];
      const point = touch ? { clientX: touch.clientX, clientY: touch.clientY } : undefined;
      const result = finishGesture(TOUCH_EVENT_POINTER_ID, point);
      if (result === "longpress" || result === "link") {
        event.stopPropagation();
        if (result === "link" && event.cancelable) event.preventDefault();
      }
    },
    [finishGesture],
  );

  const onTouchCancelCapture = useCallback(
    (event: TouchEvent<HTMLDivElement>): void => {
      if (cancelGesture(TOUCH_EVENT_POINTER_ID) === "longpress") event.stopPropagation();
    },
    [cancelGesture],
  );

  const onContextMenuCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      const gesture = touchPointerRef.current;
      if (!gesture) return;
      event.preventDefault();
      event.stopPropagation();
      markLongPress(gesture);
    },
    [markLongPress],
  );

  return {
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onTouchStartCapture,
    onTouchMoveCapture,
    onTouchEndCapture,
    onTouchCancelCapture,
    onContextMenuCapture,
  };
}
