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
});
