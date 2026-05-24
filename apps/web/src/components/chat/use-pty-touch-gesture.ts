import type { MouseEvent, PointerEvent, RefObject, TouchEvent } from "react";
import { useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";

// PTY 视图触屏手势：轻微手指漂移仍按 tap 处理，让 xterm / link 得到明确操作；
// 纵向滚动超过阈值才抑制 xterm 自动取焦，避免页面滚动时键盘被弹出。pointerId
// 锁定单指防止多指触摸误判。Terminal 实例和 suppressFocus 由调用方持有。

interface TouchGestureState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  longPressArmed: boolean;
  longPressed: boolean;
  longPressDelivered: boolean;
  touchEventStream: boolean;
  longPressTimer: number | null;
}

const TAP_MOVE_THRESHOLD_PX = 16;
const LINK_TAP_MOVE_THRESHOLD_PX = 24;
const LONG_PRESS_MOVE_CANCEL_PX = 6;
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

function gestureDistance(gesture: TouchGestureState): number {
  return Math.hypot(gesture.lastX - gesture.startX, gesture.lastY - gesture.startY);
}

declare global {
  interface Window {
    __ccTestPtyTouchGestureEvents?: unknown[];
  }
}

function recordTouchGestureDebug(event: string, details: Record<string, unknown> = {}): void {
  const events = window.__ccTestPtyTouchGestureEvents;
  if (!events) return;
  events.push({ event, t: performance.now(), ...details });
  if (events.length > 200) events.splice(0, events.length - 200);
}

interface UsePtyTouchGestureOptions {
  terminalRef: RefObject<Terminal | null>;
  suppressPtyFocus: () => void;
  onLongPressCandidateStart?: (point: { clientX: number; clientY: number }) => void;
  onTap?: (point: { clientX: number; clientY: number }) => boolean;
  isTapCandidate?: (point: { clientX: number; clientY: number }) => boolean;
  onLongPressStart?: (point: { clientX: number; clientY: number }) => void;
  onLongPressMove?: (point: { clientX: number; clientY: number }) => void;
  onLongPressEnd?: (point: { clientX: number; clientY: number }) => void;
}

export function usePtyTouchGesture({
  terminalRef,
  suppressPtyFocus,
  onLongPressCandidateStart,
  onTap,
  isTapCandidate,
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

  const startLongPress = useCallback(
    (gesture: TouchGestureState): void => {
      if (gesture.longPressed || gesture.moved) return;
      gesture.longPressed = true;
      gesture.longPressArmed = false;
      clearLongPressTimer(gesture);
      suppressPtyFocus();
      onLongPressStart?.({ clientX: gesture.startX, clientY: gesture.startY });
    },
    [clearLongPressTimer, onLongPressStart, suppressPtyFocus],
  );

  const markLongPress = useCallback(
    (gesture: TouchGestureState): void => {
      if (gesture.longPressed || gesture.longPressArmed || gesture.moved) return;
      if (gestureDistance(gesture) > LONG_PRESS_MOVE_CANCEL_PX) {
        clearLongPressTimer(gesture);
        recordTouchGestureDebug("longpress:cancel-drift", {
          distance: gestureDistance(gesture),
          threshold: LONG_PRESS_MOVE_CANCEL_PX,
        });
        return;
      }
      if (isTapCandidate?.({ clientX: gesture.startX, clientY: gesture.startY })) {
        gesture.longPressArmed = true;
        clearLongPressTimer(gesture);
        recordTouchGestureDebug("longpress:arm-link", {
          clientX: gesture.startX,
          clientY: gesture.startY,
        });
        return;
      }
      startLongPress(gesture);
    },
    [clearLongPressTimer, isTapCandidate, startLongPress],
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
        longPressArmed: false,
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
      recordTouchGestureDebug("start", { pointerId, clientX, clientY, touchEventStream });
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
      const distance = gestureDistance(gesture);
      if (gesture.longPressArmed && distance > LONG_PRESS_MOVE_CANCEL_PX) {
        gesture.longPressArmed = false;
        recordTouchGestureDebug("longpress:cancel-armed-drift", {
          pointerId,
          clientX,
          clientY,
          distance,
          threshold: LONG_PRESS_MOVE_CANCEL_PX,
        });
      }
      if (gesture.longPressed) {
        recordTouchGestureDebug("move", {
          pointerId,
          clientX,
          clientY,
          distance,
          moved: gesture.moved,
          longPressed: true,
        });
        onLongPressMove?.({ clientX, clientY });
        return true;
      }
      const dx = clientX - gesture.startX;
      const dy = clientY - gesture.startY;
      if (!gesture.moved && distance >= TAP_MOVE_THRESHOLD_PX) {
        gesture.moved = true;
        clearLongPressTimer(gesture);
      }
      recordTouchGestureDebug("move", {
        pointerId,
        clientX,
        clientY,
        dx,
        dy,
        distance,
        moved: gesture.moved,
        longPressed: false,
      });
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
      const distance = gestureDistance(gesture);
      let result: GestureFinishKind;
      if (gesture.longPressArmed) {
        if (distance <= LONG_PRESS_MOVE_CANCEL_PX) {
          startLongPress(gesture);
          deliverLongPress(gesture);
          result = "longpress";
          recordTouchGestureDebug("finish", {
            pointerId,
            result,
            point,
            moved: gesture.moved,
            distance,
            longPressed: true,
            longPressArmed: true,
          });
          return result;
        }
        gesture.longPressArmed = false;
      }
      if (gesture.longPressed) {
        deliverLongPress(gesture);
        result = "longpress";
        recordTouchGestureDebug("finish", {
          pointerId,
          result,
          point,
          moved: gesture.moved,
          longPressArmed: gesture.longPressArmed,
          distance,
          longPressed: true,
        });
        return result;
      }
      if (gesture.moved) {
        if (point && gestureDistance(gesture) <= LINK_TAP_MOVE_THRESHOLD_PX && onTap?.(point)) {
          suppressPtyFocus();
          result = "link";
          recordTouchGestureDebug("finish", {
            pointerId,
            result,
            point,
            moved: true,
            distance,
            longPressed: false,
          });
          return result;
        }
        suppressPtyFocus();
        result = "scroll";
        recordTouchGestureDebug("finish", {
          pointerId,
          result,
          point,
          moved: true,
          distance,
          longPressed: false,
        });
        return result;
      }
      if (point && onTap?.(point)) {
        suppressPtyFocus();
        result = "link";
        recordTouchGestureDebug("finish", {
          pointerId,
          result,
          point,
          moved: false,
          distance,
          longPressed: false,
        });
        return result;
      }
      terminalRef.current?.focus();
      result = "tap";
      recordTouchGestureDebug("finish", {
        pointerId,
        result,
        point,
        moved: false,
        distance,
        longPressed: false,
      });
      return result;
    },
    [clearLongPressTimer, deliverLongPress, onTap, startLongPress, suppressPtyFocus, terminalRef],
  );

  const cancelGesture = useCallback(
    (pointerId: number): GestureFinishKind | null => {
      const gesture = touchPointerRef.current;
      if (!gesture || !matchesGesturePointer(gesture, pointerId)) return null;
      clearLongPressTimer(gesture);
      touchPointerRef.current = null;
      if (gesture.longPressed) {
        deliverLongPress(gesture);
        recordTouchGestureDebug("cancel", { pointerId, result: "longpress" });
        return "longpress";
      }
      if (gesture.longPressArmed) {
        recordTouchGestureDebug("cancel", { pointerId, result: "armed" });
      }
      suppressPtyFocus();
      recordTouchGestureDebug("cancel", {
        pointerId,
        result: "scroll",
        moved: gesture.moved,
        distance: gestureDistance(gesture),
      });
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
      if (event.pointerType !== "touch") return;
      const moved = updateGestureMove(event.pointerId, event.clientX, event.clientY);
      const gesture = touchPointerRef.current;
      if (!gesture) return;
      if (!gesture.longPressed && gestureDistance(gesture) <= LINK_TAP_MOVE_THRESHOLD_PX) {
        if (event.cancelable) event.preventDefault();
      }
      if (!moved) return;
      event.stopPropagation();
      if (gesture.longPressed) event.preventDefault();
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
      const moved = updateGestureMove(TOUCH_EVENT_POINTER_ID, touch.clientX, touch.clientY);
      const gesture = touchPointerRef.current;
      if (!gesture) return;
      if (!gesture.longPressed && gestureDistance(gesture) <= LINK_TAP_MOVE_THRESHOLD_PX) {
        if (event.cancelable) event.preventDefault();
      }
      if (moved) {
        if (gesture.longPressed) {
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
      const gesture = touchPointerRef.current;
      const point = touch
        ? { clientX: touch.clientX, clientY: touch.clientY }
        : gesture
          ? { clientX: gesture.lastX, clientY: gesture.lastY }
          : undefined;
      const result = finishGesture(TOUCH_EVENT_POINTER_ID, point);
      if (result === "longpress" || result === "link") {
        event.stopPropagation();
        if (event.cancelable) event.preventDefault();
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
