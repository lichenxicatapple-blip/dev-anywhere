import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwipeableOfflineProxyRow } from "./swipeable-offline-proxy-row";

function Harness({ onRemove = vi.fn() }: { onRemove?: () => void }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <ul>
      <SwipeableOfflineProxyRow
        proxyId="proxy-old"
        name="旧 Mac"
        selected={false}
        revealed={revealed}
        onRevealedChange={setRevealed}
        onRemove={onRemove}
      />
    </ul>
  );
}

function dispatchPointer(
  element: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  point: [number, number],
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point[0],
    clientY: point[1],
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "touch" },
  });
  fireEvent(element, event);
}

function swipe(element: HTMLElement, from: [number, number], to: [number, number]) {
  dispatchPointer(element, "pointerdown", from);
  dispatchPointer(element, "pointermove", to);
  dispatchPointer(element, "pointerup", to);
}

describe("SwipeableOfflineProxyRow", () => {
  afterEach(cleanup);

  it("reveals the right-side removal action after a left swipe", () => {
    render(<Harness />);
    const foreground = screen.getByTitle("这台开发机离线。向左滑动可移除。");

    swipe(foreground, [120, 20], [40, 22]);

    expect(screen.getByRole("listitem")).toHaveAttribute("data-revealed", "true");
    expect(foreground).toHaveStyle({ transform: "translateX(-80px)" });
    expect(screen.getByRole("button", { name: "移除 旧 Mac" })).toHaveAttribute("tabindex", "0");
  });

  it("keeps the row closed when the gesture is primarily vertical", () => {
    render(<Harness />);
    const foreground = screen.getByTitle("这台开发机离线。向左滑动可移除。");

    swipe(foreground, [120, 20], [112, 90]);

    expect(screen.getByRole("listitem")).not.toHaveAttribute("data-revealed");
    expect(foreground).toHaveStyle({ transform: "translateX(-0px)" });
  });

  it("offers a discoverable button fallback and invokes removal", () => {
    const onRemove = vi.fn();
    render(<Harness onRemove={onRemove} />);

    fireEvent.click(screen.getByRole("button", { name: "显示移除 旧 Mac 操作" }));
    fireEvent.click(screen.getByRole("button", { name: "移除 旧 Mac" }));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
