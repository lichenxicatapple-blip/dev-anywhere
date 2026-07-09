import { sendRemoteInputRaw } from "./ansi-keys";

type Disposable = {
  dispose: () => void;
};

interface RawInputTerminal {
  onData: (handler: (data: string) => void) => Disposable;
  attachCustomKeyEventHandler?: (handler: (event: KeyboardEvent) => boolean) => void;
  textarea?: HTMLTextAreaElement;
}

interface XtermRawInputOptions {
  onRawInput?: (data: string) => void;
  plainEnterBehavior?: "submit" | "linefeed";
  getPlainEnterBehavior?: () => "submit" | "linefeed";
  physicalKeyboardMode?: boolean;
  isPhysicalKeyboardMode?: () => boolean;
  isInputEnabled?: () => boolean;
}

const NATIVE_TEXT_TIMEOUT_MS = 16;
const NATIVE_ECHO_SUPPRESSION_TIMEOUT_MS = 16;
const RECENT_XTERM_TEXT_TIMEOUT_MS = 16;

type PendingNativeTextInput = {
  bufferedXtermData: string[];
  keydownText: string;
  timer: ReturnType<typeof setTimeout>;
};

type NativeEchoSuppression = {
  data: string;
  keydownText: string;
  timer: ReturnType<typeof setTimeout>;
};

type NativeEchoPrefix = Pick<NativeEchoSuppression, "data" | "keydownText">;

type RecentXtermText = {
  data: string;
  timer: ReturnType<typeof setTimeout>;
};

function isPrintablePunctuationOrSymbol(data: string): boolean {
  const chars = Array.from(data);
  if (chars.length !== 1) return false;
  return /^[\p{P}\p{S}]$/u.test(chars[0]);
}

function isPrintableAsciiDigit(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x30 && code <= 0x39;
}

function hasNonAsciiText(data: string): boolean {
  for (const char of data) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0x7f) return true;
  }
  return false;
}

function shouldAcceptDirectNativeTextCommit(
  data: string,
  opts: { physicalKeyboardMode?: boolean },
): boolean {
  if (opts.physicalKeyboardMode !== true || data.length === 0) return false;
  if (data === " ") return true;
  if (hasNonAsciiText(data)) return true;
  return Array.from(data).every(isPrintablePunctuationOrSymbol);
}

function shouldRouteKeyThroughNativeInput(
  event: KeyboardEvent,
  opts: { physicalKeyboardMode?: boolean; imeComposing?: boolean } = {},
): boolean {
  if (event.type !== "keydown") return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  // IME composition 期间 keydown 仍然 fire,但字符已被输入法吞进候选;这时启动 native
  // text 探针会让 16ms 超时提交 keydown 原文,叠加 IME 提交时的完整字符串,渲染成
  // "-hello-" 这样的前缀重复。让 xterm 走默认路径,IME commit 的文本最终经
  // textarea input → xterm.onData 一次性递给我们。部分 iOS 事件不可靠设置
  // event.isComposing, 所以同时看本模块维护的 composition state。
  if (event.isComposing || opts.imeComposing) return false;
  return (
    isPrintablePunctuationOrSymbol(event.key) ||
    (opts.physicalKeyboardMode === true && (event.key === " " || isPrintableAsciiDigit(event.key)))
  );
}

function shouldPreserveSystemInputSourceShortcut(event: KeyboardEvent): boolean {
  if (event.type !== "keydown") return false;
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  return event.key === " " || event.key === "Spacebar" || event.code === "Space";
}

function shouldPreserveSystemMetaShortcut(event: KeyboardEvent): boolean {
  if (event.type !== "keydown") return false;
  return event.metaKey;
}

type HelperTextareaSnapshot = {
  inputMode: string | null;
  enterKeyHint: string | null;
  autocapitalize: string | null;
  autocomplete: string | null;
  autocorrect: string | null;
  spellcheck: boolean;
  colorScheme: string;
};

function snapshotHelperTextarea(textarea: HTMLTextAreaElement): HelperTextareaSnapshot {
  return {
    inputMode: textarea.getAttribute("inputmode"),
    enterKeyHint: textarea.getAttribute("enterkeyhint"),
    autocapitalize: textarea.getAttribute("autocapitalize"),
    autocomplete: textarea.getAttribute("autocomplete"),
    autocorrect: textarea.getAttribute("autocorrect"),
    spellcheck: textarea.spellcheck,
    colorScheme: textarea.style.colorScheme,
  };
}

function restoreHelperTextareaSnapshot(
  textarea: HTMLTextAreaElement,
  previous: HelperTextareaSnapshot,
): void {
  if (previous.inputMode === null) textarea.removeAttribute("inputmode");
  else textarea.setAttribute("inputmode", previous.inputMode);
  if (previous.enterKeyHint === null) textarea.removeAttribute("enterkeyhint");
  else textarea.setAttribute("enterkeyhint", previous.enterKeyHint);
  if (previous.autocapitalize === null) textarea.removeAttribute("autocapitalize");
  else textarea.setAttribute("autocapitalize", previous.autocapitalize);
  if (previous.autocomplete === null) textarea.removeAttribute("autocomplete");
  else textarea.setAttribute("autocomplete", previous.autocomplete);
  if (previous.autocorrect === null) textarea.removeAttribute("autocorrect");
  else textarea.setAttribute("autocorrect", previous.autocorrect);
  textarea.spellcheck = previous.spellcheck;
  textarea.style.colorScheme = previous.colorScheme;
}

function getDocumentInputColorScheme(): "dark" | "light" | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const colorScheme = window.getComputedStyle(document.documentElement).colorScheme;
  if (colorScheme.includes("dark")) return "dark";
  if (colorScheme.includes("light")) return "light";
  return null;
}

function applyTerminalInputHints(textarea: HTMLTextAreaElement): () => void {
  const previous = snapshotHelperTextarea(textarea);
  const colorScheme = getDocumentInputColorScheme();

  // PTY owns text input semantics, but the helper must remain a real text input
  // context so hardware-keyboard IME switching and composition keep working.
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.spellcheck = false;
  if (colorScheme) textarea.style.colorScheme = colorScheme;

  return () => restoreHelperTextareaSnapshot(textarea, previous);
}

function applyPhysicalKeyboardHints(textarea: HTMLTextAreaElement): () => void {
  const previous = snapshotHelperTextarea(textarea);

  // iPad hardware keyboards still need the helper textarea to remain a normal
  // text input context so system input-source switching keeps working.
  textarea.setAttribute("enterkeyhint", "send");

  return () => {
    restoreHelperTextareaSnapshot(textarea, previous);
  };
}

export function attachXtermRawInput(
  term: RawInputTerminal,
  sessionId: string,
  options: XtermRawInputOptions = {},
): Disposable {
  let pendingNativeText: PendingNativeTextInput | undefined;
  let nativeEchoSuppression: NativeEchoSuppression | undefined;
  let recentXtermText: RecentXtermText | undefined;
  let isComposing = false;
  let clearTextareaTimer: ReturnType<typeof setTimeout> | undefined;
  const isPhysicalKeyboardMode = (): boolean =>
    options.isPhysicalKeyboardMode?.() ?? options.physicalKeyboardMode === true;
  const getPlainEnterBehavior = (): "submit" | "linefeed" =>
    options.getPlainEnterBehavior?.() ?? options.plainEnterBehavior ?? "submit";
  const restoreTerminalInputHints = term.textarea
    ? applyTerminalInputHints(term.textarea)
    : undefined;
  const restorePhysicalKeyboardHints =
    isPhysicalKeyboardMode() && term.textarea
      ? applyPhysicalKeyboardHints(term.textarea)
      : undefined;

  const clearHelperTextareaSoon = (): void => {
    const textarea = term.textarea;
    if (!textarea || clearTextareaTimer) return;
    clearTextareaTimer = setTimeout(() => {
      clearTextareaTimer = undefined;
      if (!isComposing) textarea.value = "";
    }, 0);
  };

  const sendRawInput = (data: string): void => {
    if (options.isInputEnabled && !options.isInputEnabled()) {
      clearHelperTextareaSoon();
      return;
    }
    sendRemoteInputRaw(sessionId, data);
    options.onRawInput?.(data);
    clearHelperTextareaSoon();
  };

  const sendXtermInput = (data: string): void => {
    sendRawInput(data);
  };

  const clearNativeEchoSuppression = (): void => {
    if (!nativeEchoSuppression) return;
    clearTimeout(nativeEchoSuppression.timer);
    nativeEchoSuppression = undefined;
  };

  const clearRecentXtermText = (): void => {
    if (!recentXtermText) return;
    clearTimeout(recentXtermText.timer);
    recentXtermText = undefined;
  };

  const setRecentXtermText = (data: string): void => {
    clearRecentXtermText();
    if (!data) return;
    const recent: RecentXtermText = {
      data,
      timer: setTimeout(() => {
        if (recentXtermText === recent) {
          recentXtermText = undefined;
        }
      }, RECENT_XTERM_TEXT_TIMEOUT_MS),
    };
    recentXtermText = recent;
  };

  const rememberXtermText = (data: string): void => {
    setRecentXtermText(`${recentXtermText?.data ?? ""}${data}`);
  };

  const consumeRecentXtermTextPrefix = (data: string): boolean => {
    if (!recentXtermText || !data || !recentXtermText.data.startsWith(data)) return false;
    setRecentXtermText(recentXtermText.data.slice(data.length));
    return true;
  };

  const expectNativeEchoOnce = (data: string, keydownText: string): void => {
    clearNativeEchoSuppression();
    const suppression: NativeEchoSuppression = {
      data,
      keydownText,
      timer: setTimeout(() => {
        if (nativeEchoSuppression === suppression) {
          nativeEchoSuppression = undefined;
        }
      }, NATIVE_ECHO_SUPPRESSION_TIMEOUT_MS),
    };
    nativeEchoSuppression = suppression;
  };

  const stripNativeEchoPrefix = (data: string, suppression: NativeEchoPrefix): string => {
    const duplicatePrefix = data.startsWith(suppression.data)
      ? suppression.data
      : data.startsWith(suppression.keydownText)
        ? suppression.keydownText
        : "";
    return duplicatePrefix ? data.slice(duplicatePrefix.length) : data;
  };

  const stripPendingEchoPrefix = (
    data: string,
    pending: PendingNativeTextInput,
    nativeData: string,
  ): string => {
    return stripNativeEchoPrefix(data, { data: nativeData, keydownText: pending.keydownText });
  };

  const flushPendingBufferedXtermData = (
    pending: PendingNativeTextInput,
    nativeData: string,
  ): void => {
    let droppedNativeEcho = false;
    for (const buffered of pending.bufferedXtermData) {
      let next = buffered;
      if (!droppedNativeEcho) {
        const stripped = stripPendingEchoPrefix(buffered, pending, nativeData);
        if (stripped !== buffered) {
          next = stripped;
          droppedNativeEcho = true;
        }
      }
      if (next) sendXtermInput(next);
    }
  };

  const resolvePendingNativeTextInput = (data: string): void => {
    const pending = pendingNativeText;
    if (!pending) return;
    pendingNativeText = undefined;
    clearTimeout(pending.timer);
    sendRawInput(data);
    expectNativeEchoOnce(data, pending.keydownText);
    flushPendingBufferedXtermData(pending, data);
  };

  const beginPendingNativeTextInput = (keydownText: string): void => {
    if (pendingNativeText) {
      resolvePendingNativeTextInput(pendingNativeText.keydownText);
    }
    clearNativeEchoSuppression();

    const pending: PendingNativeTextInput = {
      bufferedXtermData: [],
      keydownText,
      timer: setTimeout(() => {
        if (pendingNativeText !== pending) return;
        resolvePendingNativeTextInput(keydownText);
      }, NATIVE_TEXT_TIMEOUT_MS),
    };
    pendingNativeText = pending;
  };

  const commitDirectNativeTextInput = (data: string): boolean => {
    if (
      !shouldAcceptDirectNativeTextCommit(data, {
        physicalKeyboardMode: isPhysicalKeyboardMode(),
      })
    ) {
      return false;
    }

    if (consumeRecentXtermTextPrefix(data)) {
      clearHelperTextareaSoon();
      return true;
    }

    sendRawInput(data);
    expectNativeEchoOnce(data, data);
    return true;
  };

  const onNativeInput = (event: Event): void => {
    const inputEvent = event as InputEvent;
    const data = inputEvent.data ?? "";
    if (!inputEvent.isComposing && pendingNativeText && data) {
      resolvePendingNativeTextInput(data);
      return;
    }
    if (inputEvent.isComposing) return;
    if (inputEvent.inputType !== "insertText" && inputEvent.inputType !== "insertCompositionText") {
      return;
    }
    commitDirectNativeTextInput(data);
  };

  const onCompositionStart = (): void => {
    isComposing = true;
    if (clearTextareaTimer) {
      clearTimeout(clearTextareaTimer);
      clearTextareaTimer = undefined;
    }
    const textarea = term.textarea;
    if (textarea) textarea.value = "";
  };

  const onCompositionEnd = (event: CompositionEvent): void => {
    isComposing = false;
    if (pendingNativeText && event.data) {
      resolvePendingNativeTextInput(event.data);
    }
  };

  const dataDisposable = term.onData((data) => {
    if (pendingNativeText) {
      pendingNativeText.bufferedXtermData.push(data);
      return;
    }
    if (nativeEchoSuppression) {
      const next = stripNativeEchoPrefix(data, nativeEchoSuppression);
      clearNativeEchoSuppression();
      if (next) sendXtermInput(next);
      return;
    }
    sendXtermInput(data);
    rememberXtermText(data);
  });
  term.textarea?.addEventListener("input", onNativeInput);
  term.textarea?.addEventListener("compositionstart", onCompositionStart, true);
  term.textarea?.addEventListener("compositionend", onCompositionEnd);
  term.attachCustomKeyEventHandler?.((event) => {
    if (isPhysicalKeyboardMode()) {
      if (
        shouldPreserveSystemInputSourceShortcut(event) ||
        shouldPreserveSystemMetaShortcut(event)
      ) {
        return false;
      }
    }
    if (
      shouldRouteKeyThroughNativeInput(event, {
        physicalKeyboardMode: isPhysicalKeyboardMode(),
        imeComposing: isComposing,
      })
    ) {
      beginPendingNativeTextInput(event.key);
      return false;
    }
    if (event.type !== "keydown" || event.key !== "Enter") return true;
    // Shift 与默认 Enter 行为互为反操作：submit 模式下 Enter→\r、Shift+Enter→\n；
    // linefeed 模式（移动键盘软回车）反过来——Enter→\n、Shift+Enter→\r。这样在两种模式
    // 下都能稳定地走出"提交"和"换行"两个语义，而不是让 Shift 在 linefeed 模式下变成 no-op。
    const wantLinefeedDefault = getPlainEnterBehavior() === "linefeed";
    const sendLinefeed = wantLinefeedDefault !== event.shiftKey;
    if (sendLinefeed) {
      sendRawInput("\n");
      event.preventDefault();
      return false;
    }
    return true;
  });

  return {
    dispose: () => {
      dataDisposable.dispose();
      term.textarea?.removeEventListener("input", onNativeInput);
      term.textarea?.removeEventListener("compositionstart", onCompositionStart, true);
      term.textarea?.removeEventListener("compositionend", onCompositionEnd);
      if (pendingNativeText) {
        clearTimeout(pendingNativeText.timer);
        pendingNativeText = undefined;
      }
      if (clearTextareaTimer) {
        clearTimeout(clearTextareaTimer);
        clearTextareaTimer = undefined;
      }
      restorePhysicalKeyboardHints?.();
      restoreTerminalInputHints?.();
      clearNativeEchoSuppression();
      clearRecentXtermText();
    },
  };
}
