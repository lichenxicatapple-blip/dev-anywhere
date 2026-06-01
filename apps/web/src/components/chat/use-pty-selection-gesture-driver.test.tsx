import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  usePtySelectionGestureDriver,
  type PtySelectionHandleKind,
} from "./use-pty-selection-gesture-driver";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function dispatchTouch(
  type: string,
  target: EventTarget,
  props: { clientX: number; clientY: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touch = { clientX: props.clientX, clientY: props.clientY };
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [touch] },
    changedTouches: { value: [touch] },
  });
  target.dispatchEvent(event);
  return event;
}

function Harness({
  onHandleDragStart,
  onHandleDragMove,
  onHandleDragEnd,
  onHorizontalScrollIntent,
}: {
  onHandleDragStart: (kind: PtySelectionHandleKind) => void;
  onHandleDragMove: (
    kind: PtySelectionHandleKind,
    point: { clientX: number; clientY: number },
  ) => void;
  onHandleDragEnd: (
    kind: PtySelectionHandleKind,
    point: { clientX: number; clientY: number } | null,
  ) => void;
  onHorizontalScrollIntent?: (reason: string) => void;
}) {
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const terminalRef = useRef({ focus: vi.fn() } as unknown as Terminal);
  const driver = usePtySelectionGestureDriver({
    terminalRef,
    containerEl,
    suppressPtyFocus: vi.fn(),
    isSelectionActive: () => true,
    onLongPressCandidateStart: vi.fn(),
    onLongPressStart: vi.fn(),
    onLongPressMove: vi.fn(),
    onLongPressEnd: vi.fn(),
    onHorizontalScrollIntent,
    onHandleDragStart,
    onHandleDragMove,
    onHandleDragEnd,
    onHandleDragCancel: vi.fn(),
  });

  return (
    <div ref={setContainerEl} data-testid="root" {...driver.pointerHandlers}>
      <button
        data-testid="handle"
        type="button"
        onTouchStart={(event) => driver.handlePtySelectionHandleTouchStart("focus", event)}
      />
    </div>
  );
}

function defineScrollableBox(element: HTMLElement): void {
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: 1600 });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 600 });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 400,
      width: 800,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => null,
    }) as DOMRect;
}

describe("usePtySelectionGestureDriver", () => {
  it("owns handle drag touch events and releases native scroll suppression after drag end", () => {
    const onHandleDragStart = vi.fn<(kind: PtySelectionHandleKind) => void>();
    const onHandleDragMove =
      vi.fn<(kind: PtySelectionHandleKind, point: { clientX: number; clientY: number }) => void>();
    const onHandleDragEnd =
      vi.fn<
        (kind: PtySelectionHandleKind, point: { clientX: number; clientY: number } | null) => void
      >();
    const { getByTestId } = render(
      <Harness
        onHandleDragStart={onHandleDragStart}
        onHandleDragMove={onHandleDragMove}
        onHandleDragEnd={onHandleDragEnd}
      />,
    );

    const root = getByTestId("root");
    const handle = getByTestId("handle");
    dispatchTouch("touchstart", handle, { clientX: 120, clientY: 220 });

    const suppressed = dispatchTouch("touchmove", root, { clientX: 121, clientY: 221 });
    expect(suppressed.defaultPrevented).toBe(true);

    dispatchTouch("touchmove", window, { clientX: 144, clientY: 244 });
    dispatchTouch("touchend", window, { clientX: 188, clientY: 288 });

    expect(onHandleDragStart).toHaveBeenCalledWith("focus");
    expect(onHandleDragMove).toHaveBeenCalledWith("focus", { clientX: 144, clientY: 244 });
    expect(onHandleDragEnd).toHaveBeenCalledWith("focus", { clientX: 188, clientY: 288 });

    const released = dispatchTouch("touchmove", root, { clientX: 122, clientY: 222 });
    expect(released.defaultPrevented).toBe(false);
  });

  it("marks horizontal intent before handle autoscroll changes scrollLeft", () => {
    const rafState: { pendingFrame?: FrameRequestCallback } = {};
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      rafState.pendingFrame = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const onHandleDragStart = vi.fn<(kind: PtySelectionHandleKind) => void>();
    const onHandleDragMove =
      vi.fn<(kind: PtySelectionHandleKind, point: { clientX: number; clientY: number }) => void>();
    const onHandleDragEnd =
      vi.fn<
        (kind: PtySelectionHandleKind, point: { clientX: number; clientY: number } | null) => void
      >();
    const onHorizontalScrollIntent = vi.fn<(reason: string) => void>();
    const { getByTestId } = render(
      <Harness
        onHandleDragStart={onHandleDragStart}
        onHandleDragMove={onHandleDragMove}
        onHandleDragEnd={onHandleDragEnd}
        onHorizontalScrollIntent={onHorizontalScrollIntent}
      />,
    );

    const root = getByTestId("root");
    const handle = getByTestId("handle");
    defineScrollableBox(root);

    dispatchTouch("touchstart", handle, { clientX: 120, clientY: 220 });
    dispatchTouch("touchmove", window, { clientX: 795, clientY: 220 });
    rafState.pendingFrame?.(0);

    expect(root.scrollLeft).toBeGreaterThan(0);
    expect(onHorizontalScrollIntent).toHaveBeenCalledWith(
      expect.stringContaining("selectionGestureAutoscroll"),
    );
  });
});
