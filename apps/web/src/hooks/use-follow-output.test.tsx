import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
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

function FollowOutputHarness() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { isAtBottom } = useFollowOutput(el);
  return (
    <div
      ref={(node) => {
        if (!node) return;
        setScrollMetrics(node, { scrollTop: 100, clientHeight: 100, scrollHeight: 200 });
        setEl(node);
      }}
      data-at-bottom={isAtBottom}
      data-testid="scroll"
    />
  );
}

describe("useFollowOutput", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
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
});
