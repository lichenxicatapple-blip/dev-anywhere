import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PtyMobileControls } from "./pty-mobile-controls";

describe("PtyMobileControls", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reports its rendered height so PTY spacing follows the actual layout", () => {
    const onHeightChange = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 57,
      height: 57,
      left: 0,
      right: 844,
      top: 0,
      width: 844,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    render(
      <PtyMobileControls onInput={vi.fn()} onPaste={vi.fn()} onHeightChange={onHeightChange} />,
    );

    expect(onHeightChange).toHaveBeenCalledWith(57);
  });

  it("exposes a mobile paste action without removing enter", () => {
    const onInput = vi.fn();
    const onPaste = vi.fn();

    render(<PtyMobileControls onInput={onInput} onPaste={onPaste} />);

    fireEvent.click(document.querySelector('[data-slot="pty-mobile-key-paste"]')!);
    fireEvent.click(document.querySelector('[data-slot="pty-mobile-key-enter"]')!);

    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith("\r");
  });

  it("retains Claude's one-tap clear action in the original editing position", () => {
    const onInput = vi.fn();
    const { getByRole, queryByRole } = render(
      <PtyMobileControls
        sessionKind="agent"
        provider="claude"
        onInput={onInput}
        onPaste={vi.fn()}
      />,
    );
    const clear = getByRole("button", { name: "清空输入区" });
    expect(clear.textContent).toBe("清空");
    expect(clear.getAttribute("data-key-position")).toBe("editing");
    expect(queryByRole("button", { name: "发送 Ctrl+U" })).toBeNull();
    fireEvent.click(clear);
    expect(onInput.mock.calls).toEqual([["\x1b\x1b"]]);
  });

  it.each(["codex", "kimi"] as const)(
    "restores %s whole-draft clear and suppresses rapid repeat taps",
    (provider) => {
      vi.useFakeTimers();
      const onInput = vi.fn();
      const { getByRole } = render(
        <PtyMobileControls
          sessionKind="agent"
          provider={provider}
          onInput={onInput}
          onPaste={vi.fn()}
        />,
      );
      const clear = getByRole("button", { name: "清空输入区" });
      fireEvent.click(clear);
      fireEvent.click(clear);
      expect(onInput.mock.calls).toEqual([["\x03"]]);
      expect(clear.getAttribute("aria-disabled")).toBe("true");
      act(() => vi.advanceTimersByTime(1200));
      expect(clear.textContent).toBe("清空");
      fireEvent.click(clear);
      expect(onInput.mock.calls).toEqual([["\x03"], ["\x03"]]);
    },
  );

  it("updates contextual keys when a retained view changes from an agent to CMD", () => {
    const onInput = vi.fn();
    const props = { onInput, onPaste: vi.fn() };
    const { rerender, queryByRole, getByRole } = render(
      <PtyMobileControls {...props} sessionKind="agent" provider="codex" />,
    );
    expect(queryByRole("button", { name: "发送 Ctrl+S" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "发送 Ctrl+R" }));
    rerender(
      <PtyMobileControls {...props} sessionKind="terminal" provider="claude" shellFamily="cmd" />,
    );
    expect(queryByRole("button", { name: "发送 Ctrl+R" })).toBeNull();
    expect(queryByRole("button", { name: "发送 Ctrl+U" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "发送 F7" }));
    expect(onInput.mock.calls).toEqual([["\x12"], ["\x1b[18~"]]);
  });

  it("repeats arrow input immediately after the long-press threshold", () => {
    vi.useFakeTimers();
    const onInput = vi.fn();
    const onPaste = vi.fn();

    render(<PtyMobileControls onInput={onInput} onPaste={onPaste} />);

    const leftButton = document.querySelector('[data-slot="pty-mobile-key-left"]')!;
    fireEvent.pointerDown(leftButton);

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenLastCalledWith("\x1b[D");

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onInput).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onInput).toHaveBeenCalledTimes(2);
    expect(onInput).toHaveBeenLastCalledWith("\x1b[D");

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(onInput).toHaveBeenCalledTimes(3);

    fireEvent.pointerUp(leftButton);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onInput).toHaveBeenCalledTimes(3);
  });
});
