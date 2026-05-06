import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PtyConnectionOverlay } from "./pty-connection-overlay";

afterEach(cleanup);

describe("PtyConnectionOverlay", () => {
  it("renders delayed connecting state", () => {
    render(<PtyConnectionOverlay connecting={true} subscribeExhausted={false} onRetry={vi.fn()} />);

    expect(screen.getByText("PTY 正在连接...")).toBeDefined();
  });

  it("renders retry state and calls retry action", () => {
    const onRetry = vi.fn();
    render(<PtyConnectionOverlay connecting={true} subscribeExhausted={true} onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when connected and healthy", () => {
    const { container } = render(
      <PtyConnectionOverlay connecting={false} subscribeExhausted={false} onRetry={vi.fn()} />,
    );

    expect(container.firstChild).toBeNull();
  });
});
