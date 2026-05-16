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

function Harness({ focus, suppress }: { focus: () => void; suppress: () => void }) {
  const terminalRef = useRef({ focus } as unknown as Terminal);
  const handlers = usePtyTouchGesture({ terminalRef, suppressPtyFocus: suppress });
  return (
    <div data-testid="root" {...handlers}>
      <div className="xterm" data-testid="xterm" />
    </div>
  );
}

describe("usePtyTouchGesture", () => {
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
      clientY: 112,
    });

    expect(suppress).not.toHaveBeenCalled();

    dispatchPointer("pointerup", xterm, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 112,
    });

    expect(suppress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });
});
