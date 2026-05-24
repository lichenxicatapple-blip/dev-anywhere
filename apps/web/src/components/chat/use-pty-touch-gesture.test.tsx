import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { usePtyTouchGesture } from "./use-pty-touch-gesture";

afterEach(cleanup);

function dispatchPointer(
  type: string,
  target: HTMLElement,
  props: { pointerId: number; pointerType: string; clientX: number; clientY: number },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: props.pointerId },
    pointerType: { value: props.pointerType },
    clientX: { value: props.clientX },
    clientY: { value: props.clientY },
  });
  target.dispatchEvent(event);
}

function dispatchTouch(
  type: string,
  target: HTMLElement,
  props: { clientX: number; clientY: number; omitChangedTouches?: boolean },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touch = { clientX: props.clientX, clientY: props.clientY };
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [touch] },
    changedTouches: { value: props.omitChangedTouches ? [] : [touch] },
  });
  target.dispatchEvent(event);
  return event;
}

function Harness({
  focus,
  suppress,
  onLongPressCandidateStart,
  onTap,
  isTapCandidate,
  onLongPressStart,
  onLongPressMove,
  onLongPressEnd,
}: {
  focus: () => void;
  suppress: () => void;
  onLongPressCandidateStart?: (point: { clientX: number; clientY: number }) => void;
  onTap?: (point: { clientX: number; clientY: number }) => boolean;
  isTapCandidate?: (point: { clientX: number; clientY: number }) => boolean;
  onLongPressStart?: (point: { clientX: number; clientY: number }) => void;
  onLongPressMove?: (point: { clientX: number; clientY: number }) => void;
  onLongPressEnd?: (point: { clientX: number; clientY: number }) => void;
}) {
  const terminalRef = useRef({ focus } as unknown as Terminal);
  const handlers = usePtyTouchGesture({
    terminalRef,
    suppressPtyFocus: suppress,
    onLongPressCandidateStart,
    onTap,
    isTapCandidate,
    onLongPressStart,
    onLongPressMove,
    onLongPressEnd,
  });
  return (
    <div data-testid="root" {...handlers}>
      <div className="xterm" data-testid="xterm" />
    </div>
  );
}

describe("usePtyTouchGesture", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures the long press candidate at touch start before delayed selection delivery", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressCandidateStart = vi.fn();
    const onLongPressStart = vi.fn();
    const { getByTestId } = render(
      <Harness
        focus={focus}
        suppress={suppress}
        onLongPressCandidateStart={onLongPressCandidateStart}
        onLongPressStart={onLongPressStart}
      />,
    );
    const xterm = getByTestId("xterm");

    dispatchPointer("pointerdown", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });

    expect(onLongPressCandidateStart).toHaveBeenCalledWith({ clientX: 100, clientY: 100 });
    expect(onLongPressStart).not.toHaveBeenCalled();
  });

  it("defers focus suppression until the touch scroll gesture ends", () => {
    const focus = vi.fn();
    const suppress = vi.fn();
    const { getByTestId } = render(<Harness focus={focus} suppress={suppress} />);
    const xterm = getByTestId("xterm");

    dispatchPointer("pointerdown", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    dispatchPointer("pointermove", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 120,
    });

    expect(suppress).not.toHaveBeenCalled();

    dispatchPointer("pointerup", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 120,
    });

    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("selects on long press and does not focus the terminal on release", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressStart = vi.fn();
    const onLongPressEnd = vi.fn();
    const { getByTestId } = render(
      <Harness
        focus={focus}
        suppress={suppress}
        onLongPressStart={onLongPressStart}
        onLongPressEnd={onLongPressEnd}
      />,
    );
    const xterm = getByTestId("xterm");

    dispatchPointer("pointerdown", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    vi.advanceTimersByTime(650);

    expect(onLongPressStart).toHaveBeenCalledWith({ clientX: 100, clientY: 100 });
    expect(onLongPressEnd).not.toHaveBeenCalled();
    expect(suppress).toHaveBeenCalledTimes(1);

    dispatchPointer("pointerup", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    vi.runOnlyPendingTimers();

    expect(onLongPressEnd).toHaveBeenCalledWith({ clientX: 100, clientY: 100 });
    expect(focus).not.toHaveBeenCalled();
  });

  it("updates selection while dragging after long press", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressStart = vi.fn();
    const onLongPressMove = vi.fn();
    const onLongPressEnd = vi.fn();
    const { getByTestId } = render(
      <Harness
        focus={focus}
        suppress={suppress}
        onLongPressStart={onLongPressStart}
        onLongPressMove={onLongPressMove}
        onLongPressEnd={onLongPressEnd}
      />,
    );
    const xterm = getByTestId("xterm");

    dispatchPointer("pointerdown", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    vi.advanceTimersByTime(650);
    dispatchPointer("pointermove", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 130,
      clientY: 160,
    });
    dispatchPointer("pointerup", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 130,
      clientY: 160,
    });
    vi.runOnlyPendingTimers();

    expect(onLongPressStart).toHaveBeenCalledWith({ clientX: 100, clientY: 100 });
    expect(onLongPressMove).toHaveBeenCalledWith({ clientX: 130, clientY: 160 });
    expect(onLongPressEnd).toHaveBeenCalledWith({ clientX: 130, clientY: 160 });
    expect(focus).not.toHaveBeenCalled();
  });

  it("selects when mobile Chrome emits contextmenu during long press", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressEnd = vi.fn();
    const { getByTestId } = render(
      <Harness focus={focus} suppress={suppress} onLongPressEnd={onLongPressEnd} />,
    );
    const xterm = getByTestId("xterm");

    dispatchPointer("pointerdown", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    dispatchPointer("contextmenu", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    dispatchPointer("pointercancel", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    vi.runOnlyPendingTimers();

    expect(onLongPressEnd).toHaveBeenCalledWith({ clientX: 100, clientY: 100 });
    expect(onLongPressEnd).toHaveBeenCalledTimes(1);
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("selects on long press when the browser only emits touch events", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressEnd = vi.fn();
    const { getByTestId } = render(
      <Harness focus={focus} suppress={suppress} onLongPressEnd={onLongPressEnd} />,
    );
    const xterm = getByTestId("xterm");

    dispatchTouch("touchstart", xterm, { clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(650);
    dispatchTouch("touchend", xterm, { clientX: 100, clientY: 100 });
    vi.runOnlyPendingTimers();

    expect(onLongPressEnd).toHaveBeenCalledWith({ clientX: 100, clientY: 100 });
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("activates a touch link tap without focusing the terminal", () => {
    const focus = vi.fn();
    const suppress = vi.fn();
    const onTap = vi.fn(() => true);
    const { getByTestId } = render(<Harness focus={focus} suppress={suppress} onTap={onTap} />);
    const xterm = getByTestId("xterm");

    dispatchTouch("touchstart", xterm, { clientX: 120, clientY: 140 });
    const end = dispatchTouch("touchend", xterm, { clientX: 120, clientY: 140 });

    expect(onTap).toHaveBeenCalledWith({ clientX: 120, clientY: 140 });
    expect(end.defaultPrevented).toBe(true);
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("activates a touch link tap with small finger drift", () => {
    const focus = vi.fn();
    const suppress = vi.fn();
    const onTap = vi.fn(() => true);
    const { getByTestId } = render(<Harness focus={focus} suppress={suppress} onTap={onTap} />);
    const xterm = getByTestId("xterm");

    dispatchTouch("touchstart", xterm, { clientX: 120, clientY: 140 });
    dispatchTouch("touchmove", xterm, { clientX: 124, clientY: 158 });
    const end = dispatchTouch("touchend", xterm, { clientX: 124, clientY: 158 });

    expect(onTap).toHaveBeenCalledWith({ clientX: 124, clientY: 158 });
    expect(end.defaultPrevented).toBe(true);
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not turn a drifting link tap into a long press if touch delivery is delayed", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onTap = vi.fn(() => true);
    const onLongPressStart = vi.fn();
    const { getByTestId } = render(
      <Harness
        focus={focus}
        suppress={suppress}
        onTap={onTap}
        onLongPressStart={onLongPressStart}
      />,
    );
    const xterm = getByTestId("xterm");

    dispatchTouch("touchstart", xterm, { clientX: 120, clientY: 140 });
    dispatchTouch("touchmove", xterm, { clientX: 126, clientY: 147 });
    vi.advanceTimersByTime(650);
    const end = dispatchTouch("touchend", xterm, { clientX: 126, clientY: 147 });

    expect(onLongPressStart).not.toHaveBeenCalled();
    expect(onTap).toHaveBeenCalledWith({ clientX: 126, clientY: 147 });
    expect(end.defaultPrevented).toBe(true);
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not let the long press timer preempt a known link tap candidate", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onTap = vi.fn(() => true);
    const isTapCandidate = vi.fn(() => true);
    const onLongPressStart = vi.fn();
    const { getByTestId } = render(
      <Harness
        focus={focus}
        suppress={suppress}
        onTap={onTap}
        isTapCandidate={isTapCandidate}
        onLongPressStart={onLongPressStart}
      />,
    );
    const xterm = getByTestId("xterm");

    dispatchTouch("touchstart", xterm, { clientX: 120, clientY: 140 });
    vi.advanceTimersByTime(650);
    dispatchTouch("touchmove", xterm, { clientX: 126, clientY: 147 });
    const end = dispatchTouch("touchend", xterm, { clientX: 126, clientY: 147 });

    expect(isTapCandidate).toHaveBeenCalledWith({ clientX: 120, clientY: 140 });
    expect(onLongPressStart).not.toHaveBeenCalled();
    expect(onTap).toHaveBeenCalledWith({ clientX: 126, clientY: 147 });
    expect(end.defaultPrevented).toBe(true);
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("uses the last touch point for link taps when touchend has no changedTouches", () => {
    const focus = vi.fn();
    const suppress = vi.fn();
    const onTap = vi.fn(() => true);
    const { getByTestId } = render(<Harness focus={focus} suppress={suppress} onTap={onTap} />);
    const xterm = getByTestId("xterm");

    dispatchTouch("touchstart", xterm, { clientX: 120, clientY: 140 });
    dispatchTouch("touchmove", xterm, { clientX: 124, clientY: 158 });
    const end = dispatchTouch("touchend", xterm, {
      clientX: 0,
      clientY: 0,
      omitChangedTouches: true,
    });

    expect(onTap).toHaveBeenCalledWith({ clientX: 124, clientY: 158 });
    expect(end.defaultPrevented).toBe(true);
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("finishes a long press when Chrome starts with pointer events but ends with touch events", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressMove = vi.fn();
    const onLongPressEnd = vi.fn();
    const { getByTestId } = render(
      <Harness
        focus={focus}
        suppress={suppress}
        onLongPressMove={onLongPressMove}
        onLongPressEnd={onLongPressEnd}
      />,
    );
    const xterm = getByTestId("xterm");

    dispatchPointer("pointerdown", xterm, {
      pointerId: 7,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    vi.advanceTimersByTime(650);
    dispatchTouch("touchmove", xterm, { clientX: 130, clientY: 160 });
    dispatchTouch("touchend", xterm, { clientX: 130, clientY: 160 });
    vi.runOnlyPendingTimers();

    expect(onLongPressMove).toHaveBeenCalledWith({ clientX: 130, clientY: 160 });
    expect(onLongPressEnd).toHaveBeenCalledWith({ clientX: 130, clientY: 160 });
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("keeps the touch long press alive when Chrome emits pointercancel after touchstart", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressMove = vi.fn();
    const onLongPressEnd = vi.fn();
    const { getByTestId } = render(
      <Harness
        focus={focus}
        suppress={suppress}
        onLongPressMove={onLongPressMove}
        onLongPressEnd={onLongPressEnd}
      />,
    );
    const xterm = getByTestId("xterm");

    dispatchPointer("pointerdown", xterm, {
      pointerId: 7,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    dispatchTouch("touchstart", xterm, { clientX: 100, clientY: 100 });
    dispatchPointer("pointercancel", xterm, {
      pointerId: 7,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    vi.advanceTimersByTime(650);
    dispatchTouch("touchmove", xterm, { clientX: 130, clientY: 160 });
    dispatchTouch("touchend", xterm, { clientX: 130, clientY: 160 });
    vi.runOnlyPendingTimers();

    expect(onLongPressMove).toHaveBeenCalledWith({ clientX: 130, clientY: 160 });
    expect(onLongPressEnd).toHaveBeenCalledWith({ clientX: 130, clientY: 160 });
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("cancels long press selection when the touch becomes a scroll gesture", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressEnd = vi.fn();
    const { getByTestId } = render(
      <Harness focus={focus} suppress={suppress} onLongPressEnd={onLongPressEnd} />,
    );
    const xterm = getByTestId("xterm");

    dispatchPointer("pointerdown", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    dispatchPointer("pointermove", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 120,
    });
    vi.advanceTimersByTime(650);

    expect(onLongPressEnd).not.toHaveBeenCalled();
  });

  it("lets non-selection touch scroll events reach the terminal scroll controller", () => {
    const focus = vi.fn();
    const suppress = vi.fn();
    const { getByTestId } = render(<Harness focus={focus} suppress={suppress} />);
    const root = getByTestId("root");
    const xterm = getByTestId("xterm");
    const touchstart = vi.fn();
    const touchmove = vi.fn();
    const touchend = vi.fn();
    root.addEventListener("touchstart", touchstart);
    root.addEventListener("touchmove", touchmove);
    root.addEventListener("touchend", touchend);

    dispatchTouch("touchstart", xterm, { clientX: 100, clientY: 100 });
    dispatchTouch("touchmove", xterm, { clientX: 100, clientY: 112 });
    dispatchTouch("touchmove", xterm, { clientX: 100, clientY: 120 });
    dispatchTouch("touchend", xterm, { clientX: 100, clientY: 120 });

    expect(touchstart).toHaveBeenCalledTimes(1);
    expect(touchmove).toHaveBeenCalledTimes(2);
    expect(touchend).toHaveBeenCalledTimes(1);
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });
});
