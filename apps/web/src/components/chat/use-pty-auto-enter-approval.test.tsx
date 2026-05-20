import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePtyAutoEnterApproval } from "./use-pty-auto-enter-approval";

describe("usePtyAutoEnterApproval", () => {
  it("sends Enter once for each approval window while enabled", () => {
    const sendRawInput = vi.fn();
    const { rerender } = renderHook(
      ({ waiting }) =>
        usePtyAutoEnterApproval({
          sessionId: "s1",
          enabled: true,
          waiting,
          sendRawInput,
        }),
      { initialProps: { waiting: false } },
    );

    rerender({ waiting: true });
    rerender({ waiting: true });

    expect(sendRawInput).toHaveBeenCalledTimes(1);
    expect(sendRawInput).toHaveBeenCalledWith("s1", "\r");

    rerender({ waiting: false });
    rerender({ waiting: true });

    expect(sendRawInput).toHaveBeenCalledTimes(2);
  });

  it("does not send while disabled", () => {
    const sendRawInput = vi.fn();

    renderHook(() =>
      usePtyAutoEnterApproval({
        sessionId: "s1",
        enabled: false,
        waiting: true,
        sendRawInput,
      }),
    );

    expect(sendRawInput).not.toHaveBeenCalled();
  });
});
