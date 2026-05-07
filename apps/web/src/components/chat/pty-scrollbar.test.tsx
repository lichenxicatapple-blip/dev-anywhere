import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { PtyScrollState } from "@/lib/pty-scroll-controller";
import { PtyHorizontalScrollbar, PtyScrollbar } from "./pty-scrollbar";

afterEach(cleanup);

function dispatchPointer(
  type: string,
  target: HTMLElement,
  props: { pointerId: number; clientY?: number; clientX?: number },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: props.pointerId },
    clientY: { value: props.clientY ?? 0 },
    clientX: { value: props.clientX ?? 0 },
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

function defineHorizontalTrackRect(track: HTMLElement): void {
  track.getBoundingClientRect = vi.fn(() => ({
    top: 0,
    left: 100,
    bottom: 32,
    right: 500,
    width: 400,
    height: 32,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  }));
}

function makeScrollState(overrides: Partial<PtyScrollState> = {}): PtyScrollState {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 400,
    scrollWidth: 800,
    clientHeight: 400,
    clientWidth: 800,
    scrollable: false,
    horizontalScrollable: false,
    ...overrides,
  };
}

describe("PtyScrollbar", () => {
  it("stays non-interactive when content is not scrollable", () => {
    const { container } = render(
      <PtyScrollbar state={makeScrollState()} onScrollRatio={vi.fn()} />,
    );

    const track = container.querySelector('[data-slot="pty-scrollbar"]');
    expect(track?.className).toContain("opacity-0");
    expect(track?.className).toContain("pointer-events-none");
  });

  it("renders thumb geometry from scroll state", () => {
    const { container } = render(
      <PtyScrollbar
        state={makeScrollState({ scrollTop: 800, scrollHeight: 2000, scrollable: true })}
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
        state={makeScrollState({ scrollHeight: 2000, scrollable: true })}
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

describe("PtyHorizontalScrollbar", () => {
  it("renders thumb geometry from horizontal scroll state", () => {
    const { container } = render(
      <PtyHorizontalScrollbar
        state={makeScrollState({
          scrollLeft: 400,
          scrollWidth: 1600,
          clientWidth: 800,
          horizontalScrollable: true,
        })}
        onScrollRatio={vi.fn()}
      />,
    );

    const thumb = container.querySelector<HTMLElement>(
      '[data-slot="pty-horizontal-scrollbar-thumb"]',
    );
    expect(thumb?.style.width).toBe("50%");
    expect(thumb?.style.left).toBe("25%");
  });

  it("maps pointer drag to horizontal scroll ratios", () => {
    const onScrollRatio = vi.fn();
    const { container } = render(
      <PtyHorizontalScrollbar
        state={makeScrollState({
          scrollWidth: 1600,
          clientWidth: 800,
          horizontalScrollable: true,
        })}
        onScrollRatio={onScrollRatio}
      />,
    );
    const track = container.querySelector<HTMLElement>('[data-slot="pty-horizontal-scrollbar"]');
    if (!track) throw new Error("missing horizontal scrollbar track");
    defineHorizontalTrackRect(track);
    track.setPointerCapture = vi.fn();
    track.releasePointerCapture = vi.fn();

    dispatchPointer("pointerdown", track, { pointerId: 1, clientX: 200 });
    dispatchPointer("pointermove", track, { pointerId: 1, clientX: 300 });
    dispatchPointer("pointerup", track, { pointerId: 1, clientX: 300 });

    expect(onScrollRatio).toHaveBeenNthCalledWith(1, 0.25);
    expect(onScrollRatio).toHaveBeenNthCalledWith(2, 0.5);
  });
});
