import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SendButton } from "./send-button";

const { sendControl } = vi.hoisted(() => ({
  sendControl: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { sendControl },
}));

afterEach(() => {
  cleanup();
  sendControl.mockClear();
});

describe("SendButton", () => {
  it("uses destructive treatment for the stop action", () => {
    render(<SendButton sessionId="s1" isWorking canSend={false} onSend={vi.fn()} />);

    const button = screen.getByRole("button", { name: "停止响应" });
    expect(button.getAttribute("data-variant")).toBe("stop");
    expect(button.className).toContain("bg-destructive");
  });

  it("disables stop after click and shows an indeterminate progress ring", () => {
    render(<SendButton sessionId="s1" isWorking canSend={false} onSend={vi.fn()} />);

    const button = screen.getByRole("button", { name: "停止响应" });
    fireEvent.click(button);

    expect(sendControl).toHaveBeenCalledWith({ type: "session_worker_abort", sessionId: "s1" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("stop-progress-ring")).not.toBeNull();
  });

  it("keeps stop available while exposing a queue action during work", () => {
    const onQueue = vi.fn();
    render(
      <SendButton
        sessionId="s1"
        isWorking
        canSend={false}
        canQueue
        onSend={vi.fn()}
        onQueue={onQueue}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "加入发送队列" }));

    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "停止响应" })).not.toBeNull();
  });
});
