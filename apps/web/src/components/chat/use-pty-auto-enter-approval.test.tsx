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

  it("sends again for a new approval sequence while the session remains waiting", () => {
    const sendRawInput = vi.fn();
    const { rerender } = renderHook(
      ({ approvalSeq }) =>
        usePtyAutoEnterApproval({
          sessionId: "s1",
          enabled: true,
          waiting: true,
          approvalSeq,
          sendRawInput,
        }),
      { initialProps: { approvalSeq: 1 } },
    );

    rerender({ approvalSeq: 1 });
    rerender({ approvalSeq: 2 });

    expect(sendRawInput).toHaveBeenCalledTimes(2);
    expect(sendRawInput).toHaveBeenNthCalledWith(1, "s1", "\r");
    expect(sendRawInput).toHaveBeenNthCalledWith(2, "s1", "\r");
  });

  it("does not double-send when the approval sequence follows the waiting state", () => {
    const sendRawInput = vi.fn();
    const { rerender } = renderHook(
      ({ approvalSeq }) =>
        usePtyAutoEnterApproval({
          sessionId: "s1",
          enabled: true,
          waiting: true,
          approvalSeq,
          sendRawInput,
        }),
      { initialProps: { approvalSeq: undefined as number | undefined } },
    );

    rerender({ approvalSeq: 1 });
    rerender({ approvalSeq: 2 });

    expect(sendRawInput).toHaveBeenCalledTimes(2);
  });
});
