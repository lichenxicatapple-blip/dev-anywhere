import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "@/stores/app-store";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { LatencyMonitor } from "./latency-monitor";

function dispatchPointer(
  type: string,
  target: HTMLElement,
  props: { pointerId: number; clientX: number; clientY: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: props.clientX,
    clientY: props.clientY,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: props.pointerId });
  fireEvent(target, event);
}

function defineRect(el: HTMLElement, rect: Partial<DOMRect>): void {
  el.getBoundingClientRect = vi.fn(() => ({
    top: rect.top ?? 0,
    left: rect.left ?? 0,
    bottom: rect.bottom ?? 0,
    right: rect.right ?? 0,
    width: rect.width ?? 0,
    height: rect.height ?? 0,
    x: rect.x ?? rect.left ?? 0,
    y: rect.y ?? rect.top ?? 0,
    toJSON: () => ({}),
  }));
}

describe("LatencyMonitor", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      latencyMonitorEnabled: true,
      connected: false,
      proxyOnline: false,
      selectedProxyId: "proxy-1",
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("persists a dragged floating position", () => {
    render(<LatencyMonitor />);

    const trigger = screen.getByRole("button", { name: /延迟监控/ });
    defineRect(trigger, { left: 300, top: 64, width: 120, height: 32 });
    trigger.setPointerCapture = vi.fn();
    trigger.releasePointerCapture = vi.fn();

    dispatchPointer("pointerdown", trigger, { pointerId: 1, clientX: 320, clientY: 80 });
    dispatchPointer("pointermove", trigger, { pointerId: 1, clientX: 220, clientY: 130 });
    dispatchPointer("pointerup", trigger, { pointerId: 1, clientX: 220, clientY: 130 });

    expect(trigger.style.left).toBe("200px");
    expect(trigger.style.top).toBe("114px");
    expect(localStorage.getItem(STORAGE_KEYS.latencyMonitorPosition)).toBe(
      JSON.stringify({ x: 200, y: 114 }),
    );
    expect(trigger.setPointerCapture).toHaveBeenCalledWith(1);
    expect(trigger.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("restores the floating position across pages", () => {
    localStorage.setItem(STORAGE_KEYS.latencyMonitorPosition, JSON.stringify({ x: 144, y: 88 }));

    render(<LatencyMonitor />);

    const trigger = screen.getByRole("button", { name: /延迟监控/ });
    expect(trigger.style.left).toBe("144px");
    expect(trigger.style.top).toBe("88px");
  });
});
