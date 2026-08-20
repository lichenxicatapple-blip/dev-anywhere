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
});

function dispatchTouch(
  type: string,
  target: EventTarget,
  props: { clientX: number; clientY: number; identifier?: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touch = {
    clientX: props.clientX,
    clientY: props.clientY,
    identifier: props.identifier ?? 7,
  };
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [touch] },
    changedTouches: { value: [touch] },
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchPointer(
  type: string,
  target: EventTarget,
  props: { clientX: number; clientY: number; pointerId: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: props.clientX },
    clientY: { value: props.clientY },
    pointerId: { value: props.pointerId },
    pointerType: { value: "touch" },
  });
  target.dispatchEvent(event);
  return event;
}

function Harness({
  onHandleDragStart,
  onHandleDragMove,
  onHandleDragEnd,
  onHandleDragCancel = vi.fn(),
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
  onHandleDragCancel?: (kind: PtySelectionHandleKind) => void;
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
    onHandleDragStart,
    onHandleDragMove,
    onHandleDragEnd,
    onHandleDragCancel,
  });

  return (
    <div ref={setContainerEl} data-testid="root" {...driver.pointerHandlers}>
      <button
        data-testid="handle"
        type="button"
        onPointerDown={(event) => driver.handlePtySelectionHandlePointerDown("focus", event)}
        onTouchStart={(event) => driver.handlePtySelectionHandleTouchStart("focus", event)}
      />
    </div>
  );
}

describe("usePtySelectionGestureDriver", () => {
  it("prevents touchmove only while a handle drag is active", () => {
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
    vi.spyOn(handle, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 200,
      right: 144,
      bottom: 244,
      width: 44,
      height: 44,
      x: 100,
      y: 200,
      toJSON: () => ({}),
    });
    dispatchTouch("touchstart", handle, { clientX: 120, clientY: 220 });

    const suppressed = dispatchTouch("touchmove", root, { clientX: 121, clientY: 221 });
    expect(suppressed.defaultPrevented).toBe(true);

    dispatchTouch("touchmove", window, { clientX: 144, clientY: 244 });
    dispatchTouch("touchend", window, { clientX: 188, clientY: 288 });

    expect(onHandleDragStart).toHaveBeenCalledWith("focus");
    expect(onHandleDragMove).toHaveBeenCalledWith("focus", { clientX: 146, clientY: 246 });
    expect(onHandleDragEnd).toHaveBeenCalledWith("focus", { clientX: 190, clientY: 290 });

    const released = dispatchTouch("touchmove", root, { clientX: 122, clientY: 222 });
    expect(released.defaultPrevented).toBe(false);
  });

  it("cancels an active handle drag and releases touchmove suppression on pagehide", () => {
    const onHandleDragStart = vi.fn<(kind: PtySelectionHandleKind) => void>();
    const onHandleDragMove =
      vi.fn<(kind: PtySelectionHandleKind, point: { clientX: number; clientY: number }) => void>();
    const onHandleDragEnd =
      vi.fn<
        (kind: PtySelectionHandleKind, point: { clientX: number; clientY: number } | null) => void
      >();
    const onHandleDragCancel = vi.fn<(kind: PtySelectionHandleKind) => void>();
    const { getByTestId } = render(
      <Harness
        onHandleDragStart={onHandleDragStart}
        onHandleDragMove={onHandleDragMove}
        onHandleDragEnd={onHandleDragEnd}
        onHandleDragCancel={onHandleDragCancel}
      />,
    );
    const root = getByTestId("root");
    const handle = getByTestId("handle");
    vi.spyOn(handle, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 200,
      right: 144,
      bottom: 244,
      width: 44,
      height: 44,
      x: 100,
      y: 200,
      toJSON: () => ({}),
    });

    dispatchTouch("touchstart", handle, { clientX: 120, clientY: 220 });
    window.dispatchEvent(new Event("pagehide"));
    const moveAfterPagehide = dispatchTouch("touchmove", root, {
      clientX: 121,
      clientY: 221,
    });

    expect(onHandleDragCancel).toHaveBeenCalledWith("focus");
    expect(onHandleDragCancel).toHaveBeenCalledTimes(1);
    expect(onHandleDragEnd).not.toHaveBeenCalled();
    expect(moveAfterPagehide.defaultPrevented).toBe(false);
  });

  it("keeps the initiating pointer in control when another pointer presses the handle", () => {
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
    const handle = getByTestId("handle");
    vi.spyOn(handle, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 200,
      right: 144,
      bottom: 244,
      width: 44,
      height: 44,
      x: 100,
      y: 200,
      toJSON: () => ({}),
    });

    dispatchPointer("pointerdown", handle, { pointerId: 7, clientX: 122, clientY: 222 });
    dispatchPointer("pointerdown", handle, { pointerId: 8, clientX: 130, clientY: 230 });
    dispatchPointer("pointermove", window, { pointerId: 7, clientX: 142, clientY: 242 });
    dispatchPointer("pointerup", window, { pointerId: 7, clientX: 142, clientY: 242 });

    expect(onHandleDragStart).toHaveBeenCalledTimes(1);
    expect(onHandleDragMove).toHaveBeenCalledWith("focus", { clientX: 142, clientY: 242 });
    expect(onHandleDragEnd).toHaveBeenCalledWith("focus", { clientX: 142, clientY: 242 });
  });
});
