import type { PointerEvent, RefObject } from "react";
import { useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";

// PTY 视图触屏手势：移动 8px 内视为 tap，让 xterm 取焦点；超过阈值视为 swipe，
// 抑制 xterm 自动取焦避免页面滚动时键盘被弹出。pointerId 锁定单指防止
// 多指触摸误判。Terminal 实例和 suppressFocus 由调用方持有。

interface TouchGestureState {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
}

const TAP_MOVE_THRESHOLD_PX = 8;

export interface PtyTouchGestureHandlers {
  onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMoveCapture: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancelCapture: (event: PointerEvent<HTMLDivElement>) => void;
}

interface UsePtyTouchGestureOptions {
  terminalRef: RefObject<Terminal | null>;
  suppressPtyFocus: () => void;
}

export function usePtyTouchGesture({
  terminalRef,
  suppressPtyFocus,
}: UsePtyTouchGestureOptions): PtyTouchGestureHandlers {
  const touchPointerRef = useRef<TouchGestureState | null>(null);

  const onPointerDownCapture = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== "touch") return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".xterm")) return;
    touchPointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.stopPropagation();
  }, []);

  const onPointerMoveCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const gesture = touchPointerRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) >= TAP_MOVE_THRESHOLD_PX) {
        gesture.moved = true;
        suppressPtyFocus();
      }
      if (gesture.moved) event.stopPropagation();
    },
    [suppressPtyFocus],
  );

  const onPointerUpCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const gesture = touchPointerRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      touchPointerRef.current = null;
      event.stopPropagation();
      if (gesture.moved) {
        suppressPtyFocus();
        return;
      }
      terminalRef.current?.focus();
    },
    [suppressPtyFocus, terminalRef],
  );

  const onPointerCancelCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (touchPointerRef.current?.pointerId !== event.pointerId) return;
      touchPointerRef.current = null;
      suppressPtyFocus();
    },
    [suppressPtyFocus],
  );

  return {
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
  };
}
