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
});
