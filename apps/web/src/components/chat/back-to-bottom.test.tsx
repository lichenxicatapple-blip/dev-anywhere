import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackToBottom } from "./back-to-bottom";

describe("BackToBottom", () => {
  afterEach(() => cleanup());

  it("anchors to the upper-right rail by default", () => {
    render(<BackToBottom visible hasNewMessages={false} onClick={vi.fn()} />);

    const button = screen.getByRole("button", { name: "回到底部" });
    expect(button.className).toContain("top-4");
    expect(button.className).not.toContain("bottom-");
  });

  it("allows PTY to lower the upper-right anchor below terminal overlays", () => {
    render(<BackToBottom visible hasNewMessages={false} className="top-10" onClick={vi.fn()} />);

    const button = screen.getByRole("button", { name: "回到底部" });
    expect(button.className).toContain("top-10");
    expect(button.className).not.toContain("top-4");
    expect(button.className).not.toContain("bottom-");
  });

  it("uses the same button as the shortcut to the latest output", () => {
    render(<BackToBottom visible hasNewMessages onClick={vi.fn()} />);

    const button = screen.getByRole("button", { name: "回到最新" });
    expect(button).toHaveAttribute("title", "回到最新");
    expect(button.querySelector('[data-slot="back-to-bottom-new-indicator"]')).toHaveClass(
      "opacity-100",
    );
  });
});
