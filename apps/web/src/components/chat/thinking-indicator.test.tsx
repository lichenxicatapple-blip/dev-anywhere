import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThinkingIndicator } from "./thinking-indicator";

afterEach(cleanup);

describe("ThinkingIndicator", () => {
  // 思考气泡必须复用 message-bubble 同款 dev-message-rail 横向定位, 否则宽屏下
  // (视口 > rail max-width 90rem) thinking 紧贴左侧, assistant 气泡却在 rail 内左对齐,
  // 视觉上 thinking 比 assistant 偏左 —— 用户能看出错位。
  it("aligns inside the same dev-message-rail as MessageBubble (justify-start)", () => {
    render(<ThinkingIndicator />);
    const root = screen.getByRole("status");
    const row = root.firstElementChild as HTMLElement | null;
    expect(row?.className).toContain("dev-message-rail");
    expect(row?.className).toContain("mx-auto");
    expect(row?.className).toContain("justify-start");
  });

  it("can host the active turn control without creating a separate status row", () => {
    const { container } = render(
      <ThinkingIndicator turnControl={<button type="button">停止响应</button>} />,
    );

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(container.querySelector('[data-slot="thinking-turn-control"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "停止响应" })).not.toBeNull();
  });
});
