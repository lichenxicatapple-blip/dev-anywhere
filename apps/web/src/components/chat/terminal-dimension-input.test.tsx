import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalDimensionInput } from "./terminal-dimension-input";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("@/components/toast", () => ({ toast: { error: toastError } }));
afterEach(() => {
  cleanup();
  toastError.mockClear();
});

const props = { axis: "rows", label: "行数", min: 1, max: 200, disabled: false } as const;

describe("terminal dimension editing", () => {
  it("submits positive integers on Enter or blur and allows cancelling edits", () => {
    const onCommit = vi.fn();
    render(<TerminalDimensionInput {...props} value={24} onCommit={onCommit} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(60);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(1);

    onCommit.mockClear();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue("24");
  });

  it.each(["", "0", "-1", "1.5", "1e2", "+2", "abc", "201"])(
    "rejects %j without changing the terminal",
    (draft) => {
      const onCommit = vi.fn();
      render(<TerminalDimensionInput {...props} value={24} onCommit={onCommit} />);
      const input = screen.getByRole("textbox");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: draft } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(toastError).toHaveBeenCalledWith("请输入 1–200 之间的整数");
      expect(onCommit).not.toHaveBeenCalled();
      fireEvent.blur(input);
      expect(input).toHaveValue("24");
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it("does not overwrite another viewer's resize when the input was only focused", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <TerminalDimensionInput {...props} value={24} onCommit={onCommit} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    rerender(<TerminalDimensionInput {...props} value={40} onCommit={onCommit} />);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue("40");
  });

  it("discards an edit if the connection becomes unavailable", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <TerminalDimensionInput {...props} value={24} onCommit={onCommit} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "60" } });
    rerender(<TerminalDimensionInput {...props} value={24} disabled onCommit={onCommit} />);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
