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

  it("does not treat new PTY observation sequences as new approvals", () => {
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
    rerender({ approvalSeq: 3 });

    expect(sendRawInput).toHaveBeenCalledTimes(1);
    expect(sendRawInput).toHaveBeenNthCalledWith(1, "s1", "\r");
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

    expect(sendRawInput).toHaveBeenCalledTimes(1);
  });

  it("confirms distinct permission request IDs once, even if an old request reappears", () => {
    const sendRawInput = vi.fn();
    const { rerender } = renderHook(
      ({ waiting, approvalRequestId }) =>
        usePtyAutoEnterApproval({
          sessionId: "s1",
          enabled: true,
          waiting,
          approvalRequestId,
          sendRawInput,
        }),
      { initialProps: { waiting: true, approvalRequestId: "req-1" } },
    );
    rerender({ waiting: true, approvalRequestId: "req-1" });
    rerender({ waiting: true, approvalRequestId: "req-2" });
    expect(sendRawInput).toHaveBeenCalledTimes(2);
    rerender({ waiting: false, approvalRequestId: "req-2" });
    rerender({ waiting: true, approvalRequestId: "req-2" });
    rerender({ waiting: true, approvalRequestId: "req-1" });
    expect(sendRawInput).toHaveBeenCalledTimes(2);
  });

  it("associates a late permission request ID with the fallback already confirmed", () => {
    const sendRawInput = vi.fn();
    const { rerender } = renderHook(
      ({ approvalRequestId }) =>
        usePtyAutoEnterApproval({
          sessionId: "s1",
          enabled: true,
          waiting: true,
          approvalRequestId,
          sendRawInput,
        }),
      { initialProps: { approvalRequestId: undefined as string | undefined } },
    );
    rerender({ approvalRequestId: "req-1" });
    expect(sendRawInput).toHaveBeenCalledTimes(1);
    rerender({ approvalRequestId: "req-2" });
    expect(sendRawInput).toHaveBeenCalledTimes(2);
  });

  it("confirms when enabled during a wait but does not repeat after toggling off and on", () => {
    const sendRawInput = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) =>
        usePtyAutoEnterApproval({
          sessionId: "s1",
          enabled,
          waiting: true,
          sendRawInput,
        }),
      { initialProps: { enabled: false } },
    );
    expect(sendRawInput).not.toHaveBeenCalled();
    rerender({ enabled: true });
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(sendRawInput).toHaveBeenCalledExactlyOnceWith("s1", "\r");
  });
});
