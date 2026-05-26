import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SendButton, StopButton } from "./send-button";

afterEach(() => {
  cleanup();
});

describe("SendButton", () => {
  it("uses destructive treatment for the stop action", () => {
    render(<StopButton isStopping={false} onStop={vi.fn()} />);

    const button = screen.getByRole("button", { name: "停止响应" });
    expect(button.getAttribute("data-variant")).toBe("stop");
    expect(button.className).toContain("text-destructive");
  });

  it("disables stop after click and shows an indeterminate progress ring", () => {
    const onStop = vi.fn();
    const { rerender } = render(<StopButton isStopping={false} onStop={onStop} />);

    const button = screen.getByRole("button", { name: "停止响应" });
    fireEvent.click(button);

    expect(onStop).toHaveBeenCalledTimes(1);
    rerender(<StopButton isStopping onStop={onStop} />);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("stop-progress-ring")).not.toBeNull();
  });

  it("keeps one send action during work and queues through the same button", () => {
    const onQueue = vi.fn();
    render(<SendButton isWorking canSend={false} canQueue onSend={vi.fn()} onQueue={onQueue} />);

    const button = screen.getByRole("button", { name: "发送" });
    fireEvent.click(button);

    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("data-busy-queue")).toBe("true");
    expect(screen.queryByRole("button", { name: "停止响应" })).toBeNull();
  });

  it("does not disappear while work is active and the draft cannot queue", () => {
    render(
      <SendButton isWorking canSend={false} canQueue={false} onSend={vi.fn()} onQueue={vi.fn()} />,
    );

    const button = screen.getByRole("button", { name: "发送" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
