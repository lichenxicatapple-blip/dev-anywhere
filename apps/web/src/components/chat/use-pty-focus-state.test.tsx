import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { usePtyFocusState } from "./use-pty-focus-state";

afterEach(() => {
  document.body.replaceChildren();
});

describe("usePtyFocusState", () => {
  it("can suppress focus re-entry without blurring the active PTY input", () => {
    const container = document.createElement("div");
    const host = document.createElement("div");
    const input = document.createElement("textarea");
    host.append(input);
    container.append(host);
    document.body.append(container);
    input.focus();
    const blur = vi.spyOn(input, "blur");

    const { result } = renderHook(() =>
      usePtyFocusState({
        containerEl: container,
        xtermHostRef: { current: host },
        terminalRef: { current: null as Terminal | null },
      }),
    );

    (result.current.suppressPtyFocus as (options: { blur: boolean }) => void)({ blur: false });

    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
});
