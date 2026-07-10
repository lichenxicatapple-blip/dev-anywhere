import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blurActivePtyHelperTextarea,
  canScrollVerticallyWithinBoundary,
} from "./browser-scroll-boundary";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
): void {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollTop: { configurable: true, writable: true, value: metrics.scrollTop },
  });
}

describe("browser scroll boundary", () => {
  it("blurs the active PTY helper textarea", () => {
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    document.body.appendChild(textarea);
    textarea.focus();

    expect(blurActivePtyHelperTextarea()).toBe(true);
    expect(document.activeElement).not.toBe(textarea);
  });

  it("leaves non-PTY focus alone", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    expect(blurActivePtyHelperTextarea()).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("detects whether a scrollable descendant can consume vertical scroll", () => {
    const boundary = document.createElement("div");
    const scrollable = document.createElement("div");
    const child = document.createElement("button");
    boundary.appendChild(scrollable);
    scrollable.appendChild(child);
    document.body.appendChild(boundary);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      return {
        overflowY: element === scrollable ? "auto" : "visible",
      } as CSSStyleDeclaration;
    });
    setScrollMetrics(scrollable, { scrollHeight: 500, clientHeight: 100, scrollTop: 200 });

    expect(canScrollVerticallyWithinBoundary(child, boundary, 20)).toBe(true);
    expect(canScrollVerticallyWithinBoundary(child, boundary, -20)).toBe(true);
  });

  it("rejects vertical scroll when the boundary cannot consume it", () => {
    const boundary = document.createElement("div");
    const child = document.createElement("button");
    boundary.appendChild(child);
    document.body.appendChild(boundary);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      overflowY: "visible",
    } as CSSStyleDeclaration);
    setScrollMetrics(boundary, { scrollHeight: 100, clientHeight: 100, scrollTop: 0 });

    expect(canScrollVerticallyWithinBoundary(child, boundary, 20)).toBe(false);
  });
});
