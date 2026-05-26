import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackToBottom } from "./back-to-bottom";

afterEach(cleanup);

describe("BackToBottom", () => {
  it("aligns the circular button to the shared chat rail right edge", () => {
    render(<BackToBottom visible hasNewMessages={false} onClick={vi.fn()} />);

    const button = screen.getByRole("button", { name: "回到底部" });
    expect(button.className).toContain("dev-chat-rail-floating-right");
    expect(button.className).not.toContain("right-4");
    expect(button.className).not.toContain("right-5");
    expect(button.className).not.toContain("right-6");
  });
});
