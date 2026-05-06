import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PtyScrollbar } from "./pty-scrollbar";

afterEach(cleanup);

function dispatchPointer(
  type: string,
  target: HTMLElement,
  props: { pointerId: number; clientY: number },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: props.pointerId },
    clientY: { value: props.clientY },
  });
  target.dispatchEvent(event);
}

function defineTrackRect(track: HTMLElement): void {
  track.getBoundingClientRect = vi.fn(() => ({
    top: 100,
    left: 0,
    bottom: 500,
    right: 32,
    width: 32,
    height: 400,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  }));
}

describe("PtyScrollbar", () => {
  it("stays non-interactive when content is not scrollable", () => {
    const { container } = render(
      <PtyScrollbar
        state={{ scrollTop: 0, scrollHeight: 400, clientHeight: 400, scrollable: false }}
        onScrollRatio={vi.fn()}
      />,
    );

    const track = container.querySelector('[data-slot="pty-scrollbar"]');
    expect(track?.className).toContain("opacity-0");
    expect(track?.className).toContain("pointer-events-none");
  });

  it("renders thumb geometry from scroll state", () => {
    const { container } = render(
      <PtyScrollbar
        state={{ scrollTop: 800, scrollHeight: 2000, clientHeight: 400, scrollable: true }}
        onScrollRatio={vi.fn()}
      />,
    );

    const thumb = container.querySelector<HTMLElement>('[data-slot="pty-scrollbar-thumb"]');
    expect(thumb?.style.height).toBe("20%");
    expect(thumb?.style.top).toBe("40%");
  });

  it("maps pointer drag to scroll ratios", () => {
    const onScrollRatio = vi.fn();
    const { container } = render(
      <PtyScrollbar
        state={{ scrollTop: 0, scrollHeight: 2000, clientHeight: 400, scrollable: true }}
        onScrollRatio={onScrollRatio}
      />,
    );
    const track = container.querySelector<HTMLElement>('[data-slot="pty-scrollbar"]');
    if (!track) throw new Error("missing scrollbar track");
    defineTrackRect(track);
    track.setPointerCapture = vi.fn();
    track.releasePointerCapture = vi.fn();

    dispatchPointer("pointerdown", track, { pointerId: 1, clientY: 200 });
    dispatchPointer("pointermove", track, { pointerId: 1, clientY: 300 });
    dispatchPointer("pointerup", track, { pointerId: 1, clientY: 300 });

    expect(onScrollRatio).toHaveBeenNthCalledWith(1, 0.25);
    expect(onScrollRatio).toHaveBeenNthCalledWith(2, 0.5);
    expect(track.setPointerCapture).toHaveBeenCalledWith(1);
    expect(track.releasePointerCapture).toHaveBeenCalledWith(1);
  });
});
