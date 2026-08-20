import type { MouseEvent, PointerEvent, RefObject, TouchEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";

// PTY 视图触屏手势：轻微手指漂移仍按 tap 处理，让 xterm / link 得到明确操作；
// 纵向滚动超过阈值才抑制 xterm 自动取焦，避免页面滚动时键盘被弹出。pointerId
// 锁定单指防止多指触摸误判。Terminal 实例和 suppressFocus 由调用方持有。

interface TouchGestureState {
  pointerId: number;
  touchIdentifier: number | null;
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
  scrollPositionAtStart: PtyTouchGestureScrollPosition | null;
}

const TAP_MOVE_THRESHOLD_PX = 16;
const LINK_TAP_MOVE_THRESHOLD_PX = 24;
const LONG_PRESS_MOVE_CANCEL_PX = 6;
const LONG_PRESS_DELAY_MS = 425;
const TOUCH_EVENT_POINTER_ID = -1;
export type PtyTouchGestureFinishKind = "tap" | "link" | "scroll" | "longpress";

export interface PtyTouchGestureScrollPosition {
  scrollLeft: number;
  scrollTop: number;
}

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
  return (
    gesture.pointerId === pointerId ||
    (pointerId === TOUCH_EVENT_POINTER_ID && gesture.touchIdentifier !== null)
  );
}

interface TouchContactList {
  readonly length: number;
  readonly [index: number]: {
    readonly identifier: number;
    readonly clientX: number;
    readonly clientY: number;
  };
}

interface TouchContact {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
}

function findTouchByIdentifier(
  touches: TouchContactList,
  identifier: number | null,
): TouchContact | null {
  if (identifier === null) return null;
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch?.identifier === identifier) return touch;
  }
  return null;
}

function findNearestTouch(
  touches: TouchContactList,
  point: { clientX: number; clientY: number },
): TouchContact | null {
  let nearest: TouchContact | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (!touch) continue;
    const distance = Math.hypot(touch.clientX - point.clientX, touch.clientY - point.clientY);
    if (distance >= nearestDistance) continue;
    nearest = touch;
    nearestDistance = distance;
  }
  return nearest;
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
  suppressPtyFocus: (options?: { blur?: boolean }) => void;
  focusTerminal?: () => void;
  isGestureTarget?: (point: { clientX: number; clientY: number }) => boolean;
  onLongPressCandidateStart?: (point: { clientX: number; clientY: number }) => void;
  onTap?: (point: { clientX: number; clientY: number }) => boolean;
  isTapCandidate?: (point: { clientX: number; clientY: number }) => boolean;
  onLongPressStart?: (point: { clientX: number; clientY: number }) => void;
  onLongPressMove?: (point: { clientX: number; clientY: number }) => void;
  onLongPressEnd?: (point: { clientX: number; clientY: number }) => void;
  onGestureFinish?: (kind: PtyTouchGestureFinishKind) => void;
  getScrollPosition?: () => PtyTouchGestureScrollPosition | null;
}

export function usePtyTouchGesture({
  terminalRef,
  suppressPtyFocus,
  focusTerminal,
  isGestureTarget,
  onLongPressCandidateStart,
  onTap,
  isTapCandidate,
  onLongPressStart,
  onLongPressMove,
  onLongPressEnd,
  onGestureFinish,
  getScrollPosition,
}: UsePtyTouchGestureOptions): PtyTouchGestureHandlers {
  const touchPointerRef = useRef<TouchGestureState | null>(null);
  // Chrome normally finishes a dual pointer/touch stream with pointerup before touchend. Keep the
  // first result long enough for touchend to suppress compatibility mouse/click events after a
  // link activation or long press.
  const pendingTouchFinishKindRef = useRef<{
    kind: PtyTouchGestureFinishKind;
    touchIdentifier: number | null;
  } | null>(null);

  useEffect(() => {
    // A real Chromium touchend is not guaranteed to traverse the same React root that observed
    // pointerup (the held target may have been replaced while selection UI mounted). Capture it
    // at document scope so compatibility mouse synthesis is suppressed reliably.
    const finishPendingTouch = (event: globalThis.TouchEvent): void => {
      const result = pendingTouchFinishKindRef.current;
      if (!result) return;
      if (
        result.touchIdentifier !== null &&
        !findTouchByIdentifier(event.changedTouches, result.touchIdentifier)
      ) {
        return;
      }
      pendingTouchFinishKindRef.current = null;
      if ((result.kind === "longpress" || result.kind === "link") && event.cancelable) {
        event.preventDefault();
      }
    };
    const cancelPendingTouch = (): void => {
      pendingTouchFinishKindRef.current = null;
    };
    document.addEventListener("touchend", finishPendingTouch, { capture: true, passive: false });
    document.addEventListener("touchcancel", cancelPendingTouch, { capture: true });
    return () => {
      document.removeEventListener("touchend", finishPendingTouch, { capture: true });
      document.removeEventListener("touchcancel", cancelPendingTouch, { capture: true });
    };
  }, []);

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
    (gesture: TouchGestureState, defer = true): void => {
      if (gesture.longPressDelivered || !gesture.longPressed || gesture.moved) return;
      gesture.longPressDelivered = true;
      const point = { clientX: gesture.lastX, clientY: gesture.lastY };
      if (defer) window.setTimeout(() => onLongPressEnd?.(point), 0);
      else onLongPressEnd?.(point);
    },
    [onLongPressEnd],
  );

  const startGesture = useCallback(
    (
      pointerId: number,
      clientX: number,
      clientY: number,
      touchEventStream = false,
      touchIdentifier: number | null = null,
    ): void => {
      pendingTouchFinishKindRef.current = null;
      const gesture: TouchGestureState = {
        pointerId,
        touchIdentifier,
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
        scrollPositionAtStart: getScrollPosition?.() ?? null,
      };
      gesture.longPressTimer = window.setTimeout(() => {
        if (touchPointerRef.current !== gesture) return;
        markLongPress(gesture);
      }, LONG_PRESS_DELAY_MS);
      touchPointerRef.current = gesture;
      recordTouchGestureDebug("start", { pointerId, clientX, clientY, touchEventStream });
      onLongPressCandidateStart?.({ clientX, clientY });
    },
    [getScrollPosition, markLongPress, onLongPressCandidateStart],
  );

  const didGestureScroll = useCallback(
    (gesture: TouchGestureState): boolean => {
      const start = gesture.scrollPositionAtStart;
      const current = getScrollPosition?.() ?? null;
      if (!start || !current) return false;
      return (
        Math.abs(current.scrollLeft - start.scrollLeft) > 0.5 ||
        Math.abs(current.scrollTop - start.scrollTop) > 0.5
      );
    },
    [getScrollPosition],
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
    (
      pointerId: number,
      point?: { clientX: number; clientY: number },
    ): PtyTouchGestureFinishKind | null => {
      const gesture = touchPointerRef.current;
      if (!gesture || !matchesGesturePointer(gesture, pointerId)) return null;
      if (point) {
        gesture.lastX = point.clientX;
        gesture.lastY = point.clientY;
      }
      touchPointerRef.current = null;
      clearLongPressTimer(gesture);
      const distance = gestureDistance(gesture);
      let result: PtyTouchGestureFinishKind;
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
          onGestureFinish?.(result);
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
        onGestureFinish?.(result);
        return result;
      }
      // A committed container scroll is authoritative even when Chromium coalesces touchmove or
      // the native pan starts below our 16 px tap-drift threshold. Long press remains higher
      // priority because its selection autoscroll is controller-owned.
      if (didGestureScroll(gesture)) {
        suppressPtyFocus();
        result = "scroll";
        recordTouchGestureDebug("finish", {
          pointerId,
          result,
          point,
          moved: gesture.moved,
          distance,
          longPressed: false,
          containerScrolled: true,
        });
        onGestureFinish?.(result);
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
          onGestureFinish?.(result);
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
        onGestureFinish?.(result);
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
        onGestureFinish?.(result);
        return result;
      }
      if (focusTerminal) focusTerminal();
      else terminalRef.current?.focus();
      result = "tap";
      recordTouchGestureDebug("finish", {
        pointerId,
        result,
        point,
        moved: false,
        distance,
        longPressed: false,
      });
      onGestureFinish?.(result);
      return result;
    },
    [
      clearLongPressTimer,
      deliverLongPress,
      didGestureScroll,
      focusTerminal,
      onGestureFinish,
      onTap,
      startLongPress,
      suppressPtyFocus,
      terminalRef,
    ],
  );

  const cancelGesture = useCallback(
    (
      pointerId: number,
      options: { immediateLongPressEnd?: boolean } = {},
    ): PtyTouchGestureFinishKind | null => {
      const gesture = touchPointerRef.current;
      if (!gesture || !matchesGesturePointer(gesture, pointerId)) return null;
      clearLongPressTimer(gesture);
      touchPointerRef.current = null;
      if (gesture.longPressed) {
        deliverLongPress(gesture, options.immediateLongPressEnd !== true);
        recordTouchGestureDebug("cancel", { pointerId, result: "longpress" });
        onGestureFinish?.("longpress");
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
      onGestureFinish?.("scroll");
      return "scroll";
    },
    [clearLongPressTimer, deliverLongPress, onGestureFinish, suppressPtyFocus],
  );
  const cancelGestureRef = useRef(cancelGesture);
  cancelGestureRef.current = cancelGesture;

  useEffect(() => {
    const interruptGesture = (): void => {
      pendingTouchFinishKindRef.current = null;
      const gesture = touchPointerRef.current;
      if (!gesture) return;
      cancelGestureRef.current(gesture.pointerId, { immediateLongPressEnd: true });
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
      const gesture = touchPointerRef.current;
      if (gesture) clearLongPressTimer(gesture);
      touchPointerRef.current = null;
      pendingTouchFinishKindRef.current = null;
    };
  }, [clearLongPressTimer]);

  const onPointerDownCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (event.pointerType !== "touch") return;
      const target = event.target;
      if (target instanceof Element && target.closest('[data-slot="pty-selection-handle"]')) {
        return;
      }
      if (
        !(target instanceof Element) ||
        (!target.closest(".xterm") &&
          !isGestureTarget?.({ clientX: event.clientX, clientY: event.clientY }))
      ) {
        return;
      }

      if (touchPointerRef.current) {
        event.stopPropagation();
        return;
      }

      startGesture(event.pointerId, event.clientX, event.clientY);
      event.stopPropagation();
    },
    [isGestureTarget, startGesture],
  );

  const onPointerMoveCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (event.pointerType !== "touch") return;
      const activeGesture = touchPointerRef.current;
      if (activeGesture && !matchesGesturePointer(activeGesture, event.pointerId)) {
        event.stopPropagation();
        return;
      }
      if (
        activeGesture?.touchEventStream &&
        matchesGesturePointer(activeGesture, event.pointerId)
      ) {
        // Chromium emits pointermove and touchmove for the same physical finger. Once touchstart
        // confirms the touch stream, touchmove is the sole movement authority; processing both
        // would advance selection, repaint and rebind markers twice per hardware sample.
        event.stopPropagation();
        return;
      }
      const moved = updateGestureMove(event.pointerId, event.clientX, event.clientY);
      const gesture = touchPointerRef.current;
      if (!gesture) return;
      if (!moved) return;
      event.stopPropagation();
      if (gesture.longPressed) event.preventDefault();
    },
    [updateGestureMove],
  );

  const onPointerUpCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const gesture = touchPointerRef.current;
      const result = finishGesture(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (result) {
        // Some Chromium configurations expose the pointer half through React without delivering
        // touchstart to this root, even though a native touchend still follows. Cache every touch
        // pointer result; a new gesture clears any pointer-only stale value.
        if (event.pointerType === "touch") {
          pendingTouchFinishKindRef.current = {
            kind: result,
            touchIdentifier: gesture?.touchIdentifier ?? null,
          };
        }
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
      const result = cancelGesture(event.pointerId);
      if (result) {
        if (event.pointerType === "touch") {
          pendingTouchFinishKindRef.current = {
            kind: result,
            touchIdentifier: gesture?.touchIdentifier ?? null,
          };
        }
        event.stopPropagation();
      }
    },
    [cancelGesture],
  );

  const onTouchStartCapture = useCallback(
    (event: TouchEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-slot="pty-selection-handle"]')) return;
      const touch = event.changedTouches[0] ?? event.touches[0];
      if (!touch) return;
      if (
        !target.closest(".xterm") &&
        !isGestureTarget?.({ clientX: touch.clientX, clientY: touch.clientY })
      ) {
        return;
      }
      if (touchPointerRef.current) {
        if (touchPointerRef.current.touchIdentifier === null) {
          const owner = findNearestTouch(event.changedTouches, {
            clientX: touchPointerRef.current.lastX,
            clientY: touchPointerRef.current.lastY,
          });
          if (!owner) return;
          touchPointerRef.current.touchIdentifier = owner.identifier;
          touchPointerRef.current.touchEventStream = true;
        }
        return;
      }
      startGesture(TOUCH_EVENT_POINTER_ID, touch.clientX, touch.clientY, true, touch.identifier);
    },
    [isGestureTarget, startGesture],
  );

  const onTouchMoveCapture = useCallback(
    (event: TouchEvent<HTMLDivElement>): void => {
      const activeGesture = touchPointerRef.current;
      if (!activeGesture) return;
      if (activeGesture.touchIdentifier === null) {
        const owner = findNearestTouch(
          event.changedTouches.length > 0 ? event.changedTouches : event.touches,
          { clientX: activeGesture.lastX, clientY: activeGesture.lastY },
        );
        if (!owner) return;
        activeGesture.touchIdentifier = owner.identifier;
        activeGesture.touchEventStream = true;
      }
      const changedTouch = findTouchByIdentifier(
        event.changedTouches,
        activeGesture.touchIdentifier,
      );
      if (!changedTouch && event.changedTouches.length > 0) {
        // Only another contact moved; never feed its coordinates into the initiating gesture.
        return;
      }
      const touch =
        changedTouch ?? findTouchByIdentifier(event.touches, activeGesture.touchIdentifier);
      if (!touch) return;
      const moved = updateGestureMove(TOUCH_EVENT_POINTER_ID, touch.clientX, touch.clientY);
      const currentGesture = touchPointerRef.current;
      if (!currentGesture) return;
      if (moved) {
        if (currentGesture.longPressed) {
          event.stopPropagation();
          event.preventDefault();
        }
      }
    },
    [updateGestureMove],
  );

  const onTouchEndCapture = useCallback(
    (event: TouchEvent<HTMLDivElement>): void => {
      const gesture = touchPointerRef.current;
      if (gesture?.touchIdentifier === null && event.changedTouches.length > 0) {
        const owner = findNearestTouch(event.changedTouches, {
          clientX: gesture.lastX,
          clientY: gesture.lastY,
        });
        if (owner) gesture.touchIdentifier = owner.identifier;
      }
      const touch = gesture
        ? findTouchByIdentifier(event.changedTouches, gesture.touchIdentifier)
        : null;
      if (gesture && !touch && findTouchByIdentifier(event.touches, gesture.touchIdentifier)) {
        // A different finger ended; the initiating contact still owns the gesture.
        return;
      }
      const point = touch
        ? { clientX: touch.clientX, clientY: touch.clientY }
        : gesture
          ? { clientX: gesture.lastX, clientY: gesture.lastY }
          : undefined;
      const result =
        finishGesture(TOUCH_EVENT_POINTER_ID, point) ?? pendingTouchFinishKindRef.current?.kind;
      pendingTouchFinishKindRef.current = null;
      if (result === "longpress" || result === "link") {
        event.stopPropagation();
        if (event.cancelable) event.preventDefault();
      }
    },
    [finishGesture],
  );

  const onTouchCancelCapture = useCallback(
    (event: TouchEvent<HTMLDivElement>): void => {
      const gesture = touchPointerRef.current;
      if (gesture?.touchIdentifier === null && event.changedTouches.length > 0) {
        const owner = findNearestTouch(event.changedTouches, {
          clientX: gesture.lastX,
          clientY: gesture.lastY,
        });
        if (owner) gesture.touchIdentifier = owner.identifier;
      }
      if (
        gesture &&
        !findTouchByIdentifier(event.changedTouches, gesture.touchIdentifier) &&
        findTouchByIdentifier(event.touches, gesture.touchIdentifier)
      ) {
        return;
      }
      const result =
        cancelGesture(TOUCH_EVENT_POINTER_ID) ?? pendingTouchFinishKindRef.current?.kind;
      pendingTouchFinishKindRef.current = null;
      if (result === "longpress") event.stopPropagation();
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
