import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { usePtyTouchGesture, type PtyTouchGestureFinishKind } from "./use-pty-touch-gesture";

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
  props: {
    clientX: number;
    clientY: number;
    identifier?: number;
    omitChangedTouches?: boolean;
    touches?: Array<{ clientX: number; clientY: number; identifier: number }>;
    changedTouches?: Array<{ clientX: number; clientY: number; identifier: number }>;
  },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touch = {
    clientX: props.clientX,
    clientY: props.clientY,
    identifier: props.identifier ?? 7,
  };
  Object.defineProperties(event, {
    touches: {
      value: props.touches ?? (type === "touchend" || type === "touchcancel" ? [] : [touch]),
    },
    changedTouches: {
      value: props.changedTouches ?? (props.omitChangedTouches ? [] : [touch]),
    },
  });
  target.dispatchEvent(event);
  return event;
}

function Harness({
  focus,
  focusTerminal,
  suppress,
  onLongPressCandidateStart,
  onTap,
  isTapCandidate,
  onLongPressStart,
  onLongPressMove,
  onLongPressEnd,
  onGestureFinish,
}: {
  focus: () => void;
  focusTerminal?: () => void;
  suppress: (options?: { blur?: boolean }) => void;
  onLongPressCandidateStart?: (point: { clientX: number; clientY: number }) => void;
  onTap?: (point: { clientX: number; clientY: number }) => boolean;
  isTapCandidate?: (point: { clientX: number; clientY: number }) => boolean;
  onLongPressStart?: (point: { clientX: number; clientY: number }) => void;
  onLongPressMove?: (point: { clientX: number; clientY: number }) => void;
  onLongPressEnd?: (point: { clientX: number; clientY: number }) => void;
  onGestureFinish?: (kind: PtyTouchGestureFinishKind) => void;
}) {
  const terminalRef = useRef({ focus } as unknown as Terminal);
  const handlers = usePtyTouchGesture({
    terminalRef,
    suppressPtyFocus: suppress,
    focusTerminal,
    onLongPressCandidateStart,
    onTap,
    isTapCandidate,
    onLongPressStart,
    onLongPressMove,
    onLongPressEnd,
    onGestureFinish,
  });
  return (
    <div data-testid="root" {...handlers}>
      <div className="xterm" data-testid="xterm" />
      <button type="button" data-slot="pty-selection-handle" data-testid="selection-handle" />
    </div>
  );
}

describe("usePtyTouchGesture", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the long-press candidate before delayed long-press start", () => {
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

  it("does not arm the terminal gesture router for a selection-handle contact", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressCandidateStart = vi.fn();
    const onLongPressStart = vi.fn();
    const onGestureFinish = vi.fn();
    const { getByTestId } = render(
      <Harness
        focus={focus}
        suppress={suppress}
        onLongPressCandidateStart={onLongPressCandidateStart}
        onLongPressStart={onLongPressStart}
        onGestureFinish={onGestureFinish}
      />,
    );
    const handle = getByTestId("selection-handle");

    dispatchPointer("pointerdown", handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    dispatchTouch("touchstart", handle, { clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(650);
    dispatchPointer("pointerup", handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    dispatchTouch("touchend", handle, { clientX: 100, clientY: 100 });

    expect(onLongPressCandidateStart).not.toHaveBeenCalled();
    expect(onLongPressStart).not.toHaveBeenCalled();
    expect(onGestureFinish).not.toHaveBeenCalled();
    expect(suppress).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("lets callers guard touch-start focus and restore focus only for confirmed taps", () => {
    const focus = vi.fn();
    const focusTerminal = vi.fn();
    const suppress = vi.fn();
    const onLongPressCandidateStart = vi.fn(() => suppress({ blur: false }));
    const { getByTestId } = render(
      <Harness
        focus={focus}
        focusTerminal={focusTerminal}
        suppress={suppress}
        onLongPressCandidateStart={onLongPressCandidateStart}
      />,
    );
    const xterm = getByTestId("xterm");

    dispatchPointer("pointerdown", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    dispatchPointer("pointerup", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });

    expect(suppress).toHaveBeenCalledWith({ blur: false });
    expect(focusTerminal).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("emits long-press start and end callbacks without requesting terminal focus", () => {
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

  it("forwards move and end points for an active long press", () => {
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

  it("finishes an active long press once for a contextmenu and pointercancel sequence", () => {
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

  it("emits long-press end for a touch-only event sequence", () => {
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

  it("still treats a stationary link candidate as a long press on release", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onTap = vi.fn(() => true);
    const isTapCandidate = vi.fn(() => true);
    const onLongPressStart = vi.fn();
    const onLongPressEnd = vi.fn();
    const { getByTestId } = render(
      <Harness
        focus={focus}
        suppress={suppress}
        onTap={onTap}
        isTapCandidate={isTapCandidate}
        onLongPressStart={onLongPressStart}
        onLongPressEnd={onLongPressEnd}
      />,
    );
    const xterm = getByTestId("xterm");

    dispatchTouch("touchstart", xterm, { clientX: 120, clientY: 140 });
    vi.advanceTimersByTime(650);
    const end = dispatchTouch("touchend", xterm, { clientX: 120, clientY: 140 });
    vi.runOnlyPendingTimers();

    expect(isTapCandidate).toHaveBeenCalledWith({ clientX: 120, clientY: 140 });
    expect(onTap).not.toHaveBeenCalled();
    expect(onLongPressStart).toHaveBeenCalledWith({ clientX: 120, clientY: 140 });
    expect(onLongPressEnd).toHaveBeenCalledWith({ clientX: 120, clientY: 140 });
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

  it("finishes a long press across a pointer-start and touch-end event sequence", () => {
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

  it("keeps a touch long press active across a pointercancel event sequence", () => {
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

  it("keeps the initiating touch in control when a second contact starts, moves, and ends", () => {
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
    const first = { clientX: 100, clientY: 100, identifier: 7 };
    const second = { clientX: 220, clientY: 220, identifier: 8 };

    dispatchTouch("touchstart", xterm, first);
    dispatchTouch("touchstart", xterm, {
      ...second,
      touches: [first, second],
      changedTouches: [second],
    });
    vi.advanceTimersByTime(650);
    dispatchTouch("touchmove", xterm, {
      ...second,
      clientX: 260,
      clientY: 260,
      touches: [first, { ...second, clientX: 260, clientY: 260 }],
      changedTouches: [{ ...second, clientX: 260, clientY: 260 }],
    });
    dispatchTouch("touchend", xterm, {
      ...second,
      touches: [first],
      changedTouches: [second],
    });

    expect(onLongPressMove).not.toHaveBeenCalled();
    expect(onLongPressEnd).not.toHaveBeenCalled();

    dispatchTouch("touchmove", xterm, {
      clientX: 130,
      clientY: 160,
      identifier: 7,
    });
    dispatchTouch("touchend", xterm, {
      clientX: 130,
      clientY: 160,
      identifier: 7,
    });
    vi.runOnlyPendingTimers();

    expect(onLongPressMove).toHaveBeenCalledWith({ clientX: 130, clientY: 160 });
    expect(onLongPressEnd).toHaveBeenCalledWith({ clientX: 130, clientY: 160 });
    expect(onLongPressEnd).toHaveBeenCalledTimes(1);
  });

  it("cancels an armed long-press timer when the page is hidden", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressStart = vi.fn();
    const { getByTestId } = render(
      <Harness focus={focus} suppress={suppress} onLongPressStart={onLongPressStart} />,
    );
    const xterm = getByTestId("xterm");

    dispatchTouch("touchstart", xterm, { clientX: 100, clientY: 100 });
    window.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(650);

    expect(onLongPressStart).not.toHaveBeenCalled();
  });

  it("finishes an active long press synchronously when the page is hidden", () => {
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
    window.dispatchEvent(new Event("pagehide"));

    expect(onLongPressEnd).toHaveBeenCalledWith({ clientX: 100, clientY: 100 });
    expect(onLongPressEnd).toHaveBeenCalledTimes(1);

    dispatchTouch("touchend", xterm, { clientX: 100, clientY: 100 });
    vi.runOnlyPendingTimers();
    expect(onLongPressEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps an active gesture across callback-only rerenders", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const suppress = vi.fn();
    const onLongPressStart = vi.fn();
    const onLongPressEnd = vi.fn();
    const firstFinish = vi.fn();
    const secondFinish = vi.fn();
    const rendered = render(
      <Harness
        focus={focus}
        suppress={suppress}
        onLongPressStart={onLongPressStart}
        onLongPressEnd={onLongPressEnd}
        onGestureFinish={firstFinish}
      />,
    );
    const xterm = rendered.getByTestId("xterm");

    dispatchTouch("touchstart", xterm, { clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(650);
    rendered.rerender(
      <Harness
        focus={focus}
        suppress={suppress}
        onLongPressStart={onLongPressStart}
        onLongPressEnd={onLongPressEnd}
        onGestureFinish={secondFinish}
      />,
    );
    dispatchTouch("touchend", xterm, { clientX: 100, clientY: 100 });
    vi.runOnlyPendingTimers();

    expect(onLongPressEnd).toHaveBeenCalledTimes(1);
    expect(secondFinish).toHaveBeenCalledWith("longpress");
  });
});
