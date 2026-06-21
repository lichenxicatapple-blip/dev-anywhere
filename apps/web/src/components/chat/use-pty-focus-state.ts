import type { FocusEvent, RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";

// PTY 视图的焦点状态：跟踪 xterm helper textarea 是否聚焦，并提供短暂"抑制聚焦"的窗口
// （触屏 swipe / 程序化失焦后的一段时间内忽略 focus 事件，避免软键盘弹起）。

const FOCUS_SUPPRESSION_WINDOW_MS = 900;

interface UsePtyFocusStateOptions {
  containerEl: HTMLElement | null;
  xtermHostRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
}

interface PtyFocusState {
  ptyInputFocused: boolean;
  // 进入抑制窗口：blur 当前焦点元素并屏蔽该时间窗内的所有 focus 重入。
  suppressPtyFocus: (options?: { blur?: boolean }) => void;
  focusPtyInput: () => void;
  // 直接挂到容器上的 onFocusCapture / onBlurCapture
  handleFocusCapture: (event: FocusEvent<HTMLDivElement>) => void;
  handleBlurCapture: () => void;
}

function requestVirtualKeyboard(): void {
  const keyboard = (navigator as Navigator & { virtualKeyboard?: { show?: () => void } })
    .virtualKeyboard;
  keyboard?.show?.();
}

export function usePtyFocusState(options: UsePtyFocusStateOptions): PtyFocusState {
  const { containerEl, xtermHostRef, terminalRef } = options;
  const [ptyInputFocused, setPtyInputFocused] = useState(false);
  const suppressPtyFocusUntilRef = useRef(0);

  const blurFocusedPtyInput = useCallback((): void => {
    const active = document.activeElement;
    if (!containerEl || !(active instanceof HTMLElement) || !containerEl.contains(active)) return;
    active.blur();
  }, [containerEl]);

  const syncPtyInputFocus = useCallback((): void => {
    const host = xtermHostRef.current;
    const active = document.activeElement;
    const focused = Boolean(host && active instanceof HTMLElement && host.contains(active));
    setPtyInputFocused(focused);
    if (focused) requestVirtualKeyboard();
  }, [xtermHostRef]);

  const suppressPtyFocus = useCallback(
    (options: { blur?: boolean } = {}): void => {
      suppressPtyFocusUntilRef.current = performance.now() + FOCUS_SUPPRESSION_WINDOW_MS;
      if (options.blur ?? true) {
        blurFocusedPtyInput();
        setPtyInputFocused(false);
      }
    },
    [blurFocusedPtyInput],
  );

  const handleFocusCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>): void => {
      if (performance.now() <= suppressPtyFocusUntilRef.current) {
        if (event.target instanceof HTMLElement) event.target.blur();
        window.setTimeout(syncPtyInputFocus, 0);
        return;
      }
      syncPtyInputFocus();
    },
    [syncPtyInputFocus],
  );

  const handleBlurCapture = useCallback((): void => {
    window.setTimeout(syncPtyInputFocus, 0);
  }, [syncPtyInputFocus]);

  const focusPtyInput = useCallback((): void => {
    suppressPtyFocusUntilRef.current = 0;
    terminalRef.current?.focus();
    window.setTimeout(syncPtyInputFocus, 0);
  }, [syncPtyInputFocus, terminalRef]);

  return {
    ptyInputFocused,
    suppressPtyFocus,
    focusPtyInput,
    handleFocusCapture,
    handleBlurCapture,
  };
}
