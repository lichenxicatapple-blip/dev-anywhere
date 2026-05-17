import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PtyMobileControls } from "./pty-mobile-controls";

describe("PtyMobileControls", () => {
  afterEach(() => {
    cleanup();
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

  it("clears Claude's whole agent input area with the TUI clear sequence", () => {
    const onInput = vi.fn();
    const onPaste = vi.fn();

    render(<PtyMobileControls provider="claude" onInput={onInput} onPaste={onPaste} />);

    fireEvent.click(document.querySelector('[data-slot="pty-mobile-key-clear"]')!);

    expect(onInput).toHaveBeenCalledWith("\x1b\x1b");
  });

  it("clears Codex's whole agent input area through its Ctrl+C draft clear path", () => {
    const onInput = vi.fn();
    const onPaste = vi.fn();

    render(<PtyMobileControls provider="codex" onInput={onInput} onPaste={onPaste} />);

    fireEvent.click(document.querySelector('[data-slot="pty-mobile-key-clear"]')!);

    expect(onInput).toHaveBeenCalledWith("\x03");
  });
});
