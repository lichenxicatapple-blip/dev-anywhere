import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEffect, useState } from "react";
import { useFollowOutput } from "./use-follow-output";

const resizeCallbacks = new Set<ResizeObserverCallback>();

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback);
  }

  observe() {}
  disconnect() {
    resizeCallbacks.delete(this.callback);
  }
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollTop?: number; clientHeight: number; scrollHeight: number },
) {
  if (metrics.scrollTop !== undefined) element.scrollTop = metrics.scrollTop;
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
}

function triggerResizeObservers() {
  for (const callback of resizeCallbacks) {
    callback([], {} as ResizeObserver);
  }
}

function FollowOutputHarness({ onCallback }: { onCallback?: (callback: () => void) => void }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { isAtBottom, scrollToBottom } = useFollowOutput(el);
  useEffect(() => onCallback?.(scrollToBottom), [onCallback, scrollToBottom]);
  return (
    <>
      <div
        ref={(node) => {
          if (!node) return;
          setScrollMetrics(node, { scrollTop: 100, clientHeight: 100, scrollHeight: 200 });
          setEl(node);
        }}
        data-at-bottom={isAtBottom}
        data-testid="scroll"
      />
      <button
        data-testid="lock-follow"
        onClick={() => scrollToBottom({ lockUntilUserInteraction: true })}
        type="button"
      />
    </>
  );
}

describe("useFollowOutput", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    resizeCallbacks.clear();
  });

  it("keeps following the bottom when a viewport resize shrinks the scroll container", async () => {
    const { getByTestId } = render(<FollowOutputHarness />);
    const scroll = getByTestId("scroll");

    await waitFor(() => expect(scroll.getAttribute("data-at-bottom")).toBe("true"));

    act(() => {
      setScrollMetrics(scroll, { clientHeight: 60, scrollHeight: 200 });
      triggerResizeObservers();
    });

    await waitFor(() => expect(scroll.getAttribute("data-at-bottom")).toBe("true"));
    expect(scroll.scrollTop + scroll.clientHeight).toBeGreaterThanOrEqual(scroll.scrollHeight - 8);
  });

  it("keeps the scroll callback stable when bottom state changes", async () => {
    const callbacks: Array<() => void> = [];
    const { getByTestId } = render(
      <FollowOutputHarness
        onCallback={(callback) => {
          callbacks.push(callback);
        }}
      />,
    );
    const scroll = getByTestId("scroll");
    await waitFor(() => expect(callbacks).toHaveLength(2));

    act(() => {
      setScrollMetrics(scroll, { scrollTop: 20, clientHeight: 60, scrollHeight: 200 });
      scroll.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(scroll.getAttribute("data-at-bottom")).toBe("false"));

    expect(callbacks).toHaveLength(2);
  });

  it("keeps an explicit local-send follow locked until the user interacts", async () => {
    const { getByTestId } = render(<FollowOutputHarness />);
    const scroll = getByTestId("scroll");
    fireEvent.click(getByTestId("lock-follow"));

    act(() => {
      setScrollMetrics(scroll, { scrollTop: 100, clientHeight: 100, scrollHeight: 240 });
      scroll.dispatchEvent(new Event("scroll"));
    });
    expect(scroll.scrollTop).toBe(240);
    expect(scroll.getAttribute("data-at-bottom")).toBe("true");

    act(() => {
      scroll.dispatchEvent(new Event("pointerdown"));
      setScrollMetrics(scroll, { scrollTop: 80, clientHeight: 100, scrollHeight: 240 });
      scroll.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(scroll.getAttribute("data-at-bottom")).toBe("false"));
  });
});
