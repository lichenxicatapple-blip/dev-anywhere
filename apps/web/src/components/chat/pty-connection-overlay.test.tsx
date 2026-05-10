import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PtyConnectionOverlay } from "./pty-connection-overlay";

afterEach(cleanup);

describe("PtyConnectionOverlay", () => {
  it("renders delayed connecting state", () => {
    render(<PtyConnectionOverlay connecting={true} subscribeDelayed={false} />);

    // testing-library: getByText 找不到自抛 → 无需额外 expect 包装。
    screen.getByText("正在连接终端...");
  });

  it("renders a neutral delayed sync state without retry chrome", () => {
    render(<PtyConnectionOverlay connecting={true} subscribeDelayed={true} />);

    screen.getByRole("status");
    screen.getByText("正在同步终端画面，低带宽网络可能需要更久");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("renders nothing when connected and healthy", () => {
    const { container } = render(
      <PtyConnectionOverlay connecting={false} subscribeDelayed={false} />,
    );

    expect(container.firstChild).toBeNull();
  });
});
