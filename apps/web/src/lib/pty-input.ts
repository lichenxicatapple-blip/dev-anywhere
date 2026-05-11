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
}

const NATIVE_PUNCTUATION_TIMEOUT_MS = 16;
const NATIVE_ECHO_SUPPRESSION_TIMEOUT_MS = 16;

type PendingPunctuationInput = {
  bufferedXtermData: string[];
  fallback: string;
  timer: ReturnType<typeof setTimeout>;
};

type NativeEchoSuppression = {
  data: string;
  fallback: string;
  timer: ReturnType<typeof setTimeout>;
};

type NativeEchoPrefix = Pick<NativeEchoSuppression, "data" | "fallback">;

function isPrintableAsciiPunctuation(data: string): boolean {
  if (data.length !== 1) return false;

  const code = data.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function shouldRouteKeyThroughNativeInput(event: KeyboardEvent): boolean {
  if (event.type !== "keydown") return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  // IME composition 期间 keydown 仍然 fire,但字符已被输入法吞进候选;这时启动 punctuation
  // 探针会让 16ms 超时 fallback 发出一个孤立字符,叠加 IME 提交时的完整字符串,渲染成
  // "-hello-" 这样的前缀重复 (item 7 现场)。让 xterm 走默认路径,IME commit 的文本最终
  // 经 textarea input → xterm.onData 一次性递给我们。
  if (event.isComposing) return false;
  return isPrintableAsciiPunctuation(event.key);
}

export function attachXtermRawInput(
  term: RawInputTerminal,
  sessionId: string,
  options: XtermRawInputOptions = {},
): Disposable {
  let pendingPunctuation: PendingPunctuationInput | undefined;
  let nativeEchoSuppression: NativeEchoSuppression | undefined;

  const sendRawInput = (data: string): void => {
    sendRemoteInputRaw(sessionId, data);
    options.onRawInput?.(data);
  };

  const sendXtermInput = (data: string): void => {
    sendRawInput(data);
  };

  const clearNativeEchoSuppression = (): void => {
    if (!nativeEchoSuppression) return;
    clearTimeout(nativeEchoSuppression.timer);
    nativeEchoSuppression = undefined;
  };

  const expectNativeEchoOnce = (data: string, fallback: string): void => {
    clearNativeEchoSuppression();
    const suppression: NativeEchoSuppression = {
      data,
      fallback,
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
      : data.startsWith(suppression.fallback)
        ? suppression.fallback
        : "";
    return duplicatePrefix ? data.slice(duplicatePrefix.length) : data;
  };

  const stripPendingEchoPrefix = (
    data: string,
    pending: PendingPunctuationInput,
    nativeData: string,
  ): string => {
    return stripNativeEchoPrefix(data, { data: nativeData, fallback: pending.fallback });
  };

  const flushPendingBufferedXtermData = (
    pending: PendingPunctuationInput,
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

  const resolvePendingPunctuationInput = (data: string): void => {
    const pending = pendingPunctuation;
    if (!pending) return;
    pendingPunctuation = undefined;
    clearTimeout(pending.timer);
    sendRawInput(data);
    expectNativeEchoOnce(data, pending.fallback);
    flushPendingBufferedXtermData(pending, data);
  };

  const beginPendingPunctuationInput = (fallback: string): void => {
    if (pendingPunctuation) {
      resolvePendingPunctuationInput(pendingPunctuation.fallback);
    }
    clearNativeEchoSuppression();

    const pending: PendingPunctuationInput = {
      bufferedXtermData: [],
      fallback,
      timer: setTimeout(() => {
        if (pendingPunctuation !== pending) return;
        resolvePendingPunctuationInput(fallback);
      }, NATIVE_PUNCTUATION_TIMEOUT_MS),
    };
    pendingPunctuation = pending;
  };

  const onNativeInput = (event: Event): void => {
    const inputEvent = event as InputEvent;
    if (inputEvent.isComposing || inputEvent.inputType !== "insertText") return;
    const data = inputEvent.data ?? "";
    if (pendingPunctuation && data) resolvePendingPunctuationInput(data);
  };

  const dataDisposable = term.onData((data) => {
    if (pendingPunctuation) {
      pendingPunctuation.bufferedXtermData.push(data);
      return;
    }
    if (nativeEchoSuppression) {
      const next = stripNativeEchoPrefix(data, nativeEchoSuppression);
      clearNativeEchoSuppression();
      if (next) sendXtermInput(next);
      return;
    }
    sendXtermInput(data);
  });
  term.textarea?.addEventListener("input", onNativeInput);
  term.attachCustomKeyEventHandler?.((event) => {
    if (shouldRouteKeyThroughNativeInput(event)) {
      beginPendingPunctuationInput(event.key);
      return false;
    }
    if (event.type !== "keydown" || event.key !== "Enter") return true;
    // Shift 与默认 Enter 行为互为反操作：submit 模式下 Enter→\r、Shift+Enter→\n；
    // linefeed 模式（移动键盘软回车）反过来——Enter→\n、Shift+Enter→\r。这样在两种模式
    // 下都能稳定地走出"提交"和"换行"两个语义，而不是让 Shift 在 linefeed 模式下变成 no-op。
    const wantLinefeedDefault = options.plainEnterBehavior === "linefeed";
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
      if (pendingPunctuation) {
        clearTimeout(pendingPunctuation.timer);
        pendingPunctuation = undefined;
      }
      clearNativeEchoSuppression();
    },
  };
}
