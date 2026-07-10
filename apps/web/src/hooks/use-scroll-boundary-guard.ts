import { useCallback, useRef } from "react";
import type { TouchEvent as ReactTouchEvent, WheelEvent as ReactWheelEvent } from "react";
import {
  blurActivePtyHelperTextarea,
  canScrollVerticallyWithinBoundary,
} from "@/lib/browser-scroll-boundary";

interface ScrollBoundaryGuardHandlers {
  onPointerDownCapture: () => void;
  onTouchStartCapture: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchMoveCapture: (event: ReactTouchEvent<HTMLElement>) => void;
  onWheelCapture: (event: ReactWheelEvent<HTMLElement>) => void;
}

interface UseScrollBoundaryGuardOptions {
  releasePtyFocus?: boolean;
  containVerticalScroll?: boolean;
}

export function useScrollBoundaryGuard({
  releasePtyFocus = true,
  containVerticalScroll = true,
}: UseScrollBoundaryGuardOptions = {}): ScrollBoundaryGuardHandlers {
  const lastTouchYRef = useRef<number | null>(null);

  const releaseFocus = useCallback((): void => {
    if (releasePtyFocus) blurActivePtyHelperTextarea();
  }, [releasePtyFocus]);

  const onTouchStartCapture = useCallback(
    (event: ReactTouchEvent<HTMLElement>): void => {
      lastTouchYRef.current = event.touches[0]?.clientY ?? null;
      releaseFocus();
    },
    [releaseFocus],
  );

  const onTouchMoveCapture = useCallback(
    (event: ReactTouchEvent<HTMLElement>): void => {
      if (!containVerticalScroll) return;
      const touch = event.touches[0];
      if (!touch) return;
      const previousY = lastTouchYRef.current ?? touch.clientY;
      const deltaY = previousY - touch.clientY;
      lastTouchYRef.current = touch.clientY;
      if (!canScrollVerticallyWithinBoundary(event.target, event.currentTarget, deltaY)) {
        event.preventDefault();
      }
    },
    [containVerticalScroll],
  );

  const onWheelCapture = useCallback(
    (event: ReactWheelEvent<HTMLElement>): void => {
      releaseFocus();
      if (!containVerticalScroll) return;
      if (!canScrollVerticallyWithinBoundary(event.target, event.currentTarget, event.deltaY)) {
        event.preventDefault();
      }
    },
    [containVerticalScroll, releaseFocus],
  );

  return {
    onPointerDownCapture: releaseFocus,
    onTouchStartCapture,
    onTouchMoveCapture,
    onWheelCapture,
  };
}
