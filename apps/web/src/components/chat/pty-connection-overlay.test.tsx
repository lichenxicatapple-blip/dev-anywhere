import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PtyConnectionOverlay } from "./pty-connection-overlay";

afterEach(cleanup);

describe("PtyConnectionOverlay", () => {
  it("renders delayed connecting state", () => {
    render(<PtyConnectionOverlay connecting={true} subscribeDelayed={false} />);

    expect(screen.getByText("正在连接终端...")).toBeDefined();
  });

  it("renders a neutral delayed sync state without retry chrome", () => {
    render(<PtyConnectionOverlay connecting={true} subscribeDelayed={true} />);

    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.getByText("正在同步终端画面，低带宽网络可能需要更久")).toBeDefined();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("renders nothing when connected and healthy", () => {
    const { container } = render(
      <PtyConnectionOverlay connecting={false} subscribeDelayed={false} />,
    );

    expect(container.firstChild).toBeNull();
  });
});
