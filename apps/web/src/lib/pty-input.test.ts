import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachXtermRawInput } from "./pty-input";

const sendSpy = vi.fn();
vi.mock("./ansi-keys", () => ({
  sendRemoteInputRaw: (sessionId: string, data: string) => sendSpy(sessionId, data),
}));

describe("attachXtermRawInput", () => {
  beforeEach(() => {
    sendSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTerminal() {
    let dataHandler: ((data: string) => void) | undefined;
    let keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
    const disposeSpy = vi.fn();
    const textarea = document.createElement("textarea");
    const terminal = {
      textarea,
      onData: vi.fn((next: (data: string) => void) => {
        dataHandler = next;
        return { dispose: disposeSpy };
      }),
      attachCustomKeyEventHandler: vi.fn((next: (event: KeyboardEvent) => boolean) => {
        keyHandler = next;
      }),
    };
    return {
      terminal,
      disposeSpy,
      textarea,
      emitData: (data: string) => dataHandler?.(data),
      emitKey: (event: KeyboardEvent) => keyHandler?.(event),
      emitTextInput: (data: string, inputType = "insertText") => {
        textarea.dispatchEvent(
          new InputEvent("input", {
            data,
            inputType,
            bubbles: true,
            composed: true,
          }),
        );
      },
      emitCompositionStart: () => {
        textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      },
      emitCompositionEnd: (data = "") => {
        textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data }));
      },
    };
  }

  it.each([
    ["plain text", "abc"],
    ["enter", "\r"],
    ["backspace", "\x7f"],
    ["tab", "\t"],
    ["escape", "\x1b"],
    ["shift+tab", "\x1b[Z"],
    ["ctrl+c", "\x03"],
    ["arrow up", "\x1b[A"],
    ["arrow down", "\x1b[B"],
    ["arrow right", "\x1b[C"],
    ["arrow left", "\x1b[D"],
    ["paste", "first line\nsecond line"],
    ["ime text", "你好，世界"],
  ])("forwards %s xterm onData payloads as raw PTY input", (_label, data) => {
    const { terminal, disposeSpy, emitData } = createTerminal();
    const onRawInput = vi.fn();

    const disposable = attachXtermRawInput(terminal, "sess-1", { onRawInput });
    emitData(data);

    expect(terminal.onData).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", data);
    expect(onRawInput).toHaveBeenCalledWith(data);

    disposable.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards repeated Ctrl+C without debouncing terminal semantics", () => {
    const { terminal, emitData } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    emitData("\x03");
    emitData("\x03");

    expect(sendSpy).toHaveBeenNthCalledWith(1, "sess-1", "\x03");
    expect(sendSpy).toHaveBeenNthCalledWith(2, "sess-1", "\x03");
  });

  it("blocks raw input while the PTY view is not ready for interactive use", () => {
    const { terminal, emitData, emitKey } = createTerminal();
    const onRawInput = vi.fn();
    let enabled = false;

    attachXtermRawInput(terminal, "sess-1", {
      onRawInput,
      isInputEnabled: () => enabled,
    });

    emitData("old-typed-text");
    expect(sendSpy).not.toHaveBeenCalled();
    expect(onRawInput).not.toHaveBeenCalled();

    enabled = true;
    emitData("ready-text");
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "ready-text");
    expect(onRawInput).toHaveBeenCalledWith("ready-text");

    enabled = false;
    const blockedEnter = emitKey(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(blockedEnter).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("clears xterm helper textarea after forwarding raw input so IME commits cannot reuse stale text", () => {
    vi.useFakeTimers();
    const { terminal, textarea, emitData } = createTerminal();

    textarea.value = "previous input";
    attachXtermRawInput(terminal, "sess-1");
    emitData("新内容");

    expect(sendSpy).toHaveBeenCalledWith("sess-1", "新内容");
    expect(textarea.value).toBe("previous input");

    vi.runAllTimers();

    expect(textarea.value).toBe("");
  });

  it("clears stale helper textarea at composition start but preserves active IME composition text", () => {
    vi.useFakeTimers();
    const { terminal, textarea, emitCompositionStart, emitCompositionEnd, emitData } =
      createTerminal();

    textarea.value = "上一轮输入";
    attachXtermRawInput(terminal, "sess-1");
    emitCompositionStart();
    expect(textarea.value).toBe("");

    textarea.value = "候选";
    emitData("候选");

    vi.runOnlyPendingTimers();
    expect(textarea.value).toBe("候选");

    emitCompositionEnd();
    emitData("完成");
    vi.runOnlyPendingTimers();

    expect(textarea.value).toBe("");
  });

  it("maps Shift+Enter to LF instead of xterm's default Enter submit", () => {
    const { terminal, emitKey } = createTerminal();
    const onRawInput = vi.fn();
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true });
    const preventDefault = vi.spyOn(event, "preventDefault");

    attachXtermRawInput(terminal, "sess-1", { onRawInput });
    const shouldContinue = emitKey(event);

    expect(shouldContinue).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "\n");
    expect(onRawInput).toHaveBeenCalledWith("\n");
  });

  it("lets plain Enter continue through xterm's normal CR path", () => {
    const { terminal, emitKey } = createTerminal();
    const event = new KeyboardEvent("keydown", { key: "Enter" });

    attachXtermRawInput(terminal, "sess-1");

    expect(emitKey(event)).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("routes printable punctuation through native text input so IME punctuation is preserved", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "," }));
    emitTextInput("，");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "，");
  });

  it("keeps ASCII punctuation working when no IME transforms it", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "," }));
    emitTextInput(",");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", ",");
  });

  it("routes physical keyboard punctuation through native input so hardware IME punctuation is preserved", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "," }));
    emitTextInput("，");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "，");
  });

  it("routes full-width physical keyboard punctuation through native input", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "，" }));
    emitTextInput("，");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "，");
  });

  it("accepts physical-keyboard IME punctuation committed directly by the helper textarea", () => {
    vi.useFakeTimers();
    const { terminal, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    emitTextInput("，");
    vi.runAllTimers();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "，");
  });

  it("does not duplicate direct helper-textarea commits already emitted by xterm", () => {
    vi.useFakeTimers();
    const { terminal, emitData, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    emitData("，");
    emitTextInput("，");
    vi.runAllTimers();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "，");
  });

  it("commits keydown punctuation in physical keyboard mode when native input is not emitted", () => {
    vi.useFakeTimers();
    const { terminal, emitKey } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "," }));
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", ",");
  });

  it("routes physical-keyboard digits through native input so IME digits are preserved", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "1", code: "Digit1" }));
    emitTextInput("１");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "１");
  });

  it("commits keydown digits in physical keyboard mode when native input is not emitted", () => {
    vi.useFakeTimers();
    const { terminal, emitKey } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "1", code: "Digit1" }));
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "1");
  });

  it("accepts pending IME punctuation from non-insertText native input events", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "." }));
    emitTextInput("。", "insertCompositionText");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "。");
  });

  it("accepts pending IME punctuation from compositionend", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitCompositionEnd } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "," }));
    emitCompositionEnd("，");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "，");
  });

  it("marks the helper textarea as hardware-keyboard oriented without disabling text input context", () => {
    const { terminal, textarea } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });

    expect(textarea.getAttribute("inputmode")).toBeNull();
    expect(textarea.getAttribute("enterkeyhint")).toBe("send");
    expect(textarea.getAttribute("autocapitalize")).toBe("off");
    expect(textarea.getAttribute("autocomplete")).toBe("off");
    expect(textarea.getAttribute("autocorrect")).toBe("off");
    expect(textarea.spellcheck).toBe(false);
  });

  it("preserves a pre-existing helper textarea input mode in physical keyboard mode", () => {
    const { terminal, textarea } = createTerminal();
    textarea.setAttribute("inputmode", "text");

    const disposable = attachXtermRawInput(terminal, "sess-1", {
      physicalKeyboardMode: true,
    });

    expect(textarea.getAttribute("inputmode")).toBe("text");

    disposable.dispose();
    expect(textarea.getAttribute("inputmode")).toBe("text");
  });

  it("lets system input-source switching bypass xterm in physical keyboard mode", () => {
    const { terminal, emitKey } = createTerminal();
    const event = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      ctrlKey: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(event);

    expect(shouldContinue).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("lets system Meta shortcuts bypass xterm in physical keyboard mode", () => {
    const { terminal, emitKey } = createTerminal();
    const event = new KeyboardEvent("keydown", {
      key: "c",
      code: "KeyC",
      metaKey: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(event);

    expect(shouldContinue).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("keeps terminal control shortcuts routed through xterm in physical keyboard mode", () => {
    const { terminal, emitKey } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }));

    expect(shouldContinue).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["Tab", new KeyboardEvent("keydown", { key: "Tab", code: "Tab" })],
    ["Shift+Tab", new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: true })],
  ])("keeps terminal %s shortcuts routed through xterm in physical keyboard mode", (_label, event) => {
    const { terminal, emitKey } = createTerminal();
    const preventDefault = vi.spyOn(event, "preventDefault");

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(event);

    expect(shouldContinue).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does not start a second punctuation probe from the matching keypress event", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    const keydownContinue = emitKey(new KeyboardEvent("keydown", { key: "-" }));
    const keypressContinue = emitKey(new KeyboardEvent("keypress", { key: "-" }));
    emitTextInput("-");
    vi.runAllTimers();

    expect(keydownContinue).toBe(false);
    expect(keypressContinue).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "-");
  });

  it("preserves input order when xterm emits text after routed punctuation", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitData, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "/" }));
    emitData("tmp");
    emitTextInput("/");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenNthCalledWith(1, "sess-1", "/");
    expect(sendSpy).toHaveBeenNthCalledWith(2, "sess-1", "tmp");
  });

  it("does not duplicate routed punctuation when xterm also emits the native text", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitData, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "-" }));
    emitData("-chaos");
    emitTextInput("-");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenNthCalledWith(1, "sess-1", "-");
    expect(sendSpy).toHaveBeenNthCalledWith(2, "sess-1", "chaos");
  });

  it("drops a late xterm echo after native punctuation has already been forwarded", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitData, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "-" }));
    emitTextInput("-");
    emitData("-");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "-");
  });

  it("keeps late xterm text after dropping a native punctuation echo", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitData, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "-" }));
    emitTextInput("-");
    emitData("-chaos");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenNthCalledWith(1, "sess-1", "-");
    expect(sendSpy).toHaveBeenNthCalledWith(2, "sess-1", "chaos");
  });

  it("does not strip later xterm input after the native echo window expires", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitData, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "-" }));
    emitTextInput("-");
    vi.advanceTimersByTime(20);
    emitData("-pasted");

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenNthCalledWith(1, "sess-1", "-");
    expect(sendSpy).toHaveBeenNthCalledWith(2, "sess-1", "-pasted");
  });

  it("prefers IME-transformed punctuation over a buffered ASCII xterm echo", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitData, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: "," }));
    emitData(",后续");
    emitTextInput("，");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenNthCalledWith(1, "sess-1", "，");
    expect(sendSpy).toHaveBeenNthCalledWith(2, "sess-1", "后续");
  });

  it("does not duplicate native text input when xterm already emitted the same text", () => {
    vi.useFakeTimers();
    const { terminal, emitData, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    emitData("你好");
    emitTextInput("你好");
    vi.runAllTimers();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "你好");
  });

  it("routes physical-keyboard space through native input so IME space is preserved", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: " ", code: "Space" }));
    emitTextInput(" ");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", " ");
  });

  it("commits physical-keyboard space when native input is not emitted", () => {
    vi.useFakeTimers();
    const { terminal, emitKey } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: " ", code: "Space" }));
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", " ");
  });

  it("does not duplicate physical-keyboard space when xterm also emitted it", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitData, emitTextInput } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    const shouldContinue = emitKey(new KeyboardEvent("keydown", { key: " ", code: "Space" }));
    emitData(" ");
    emitTextInput(" ");
    vi.runAllTimers();

    expect(shouldContinue).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", " ");
  });

  // 中文 IME 下用户快速输入 "hello-",IME 把 "-" 吃进 composition;
  // 此时 keydown(-) 仍然 fire 但 event.isComposing=true。如果把它当成普通 ASCII 启动
  // punctuation 探针 16ms 等 native echo,IME 同时把 "-" 吞了不发 textarea input,探针
  // 超时提交 keydown 原文 "-",紧接着 IME commit "hello-" 经 onData 又来一次,
  // 终端就渲染成 "-hello-"。
  it("does not start a punctuation probe when keydown fires during IME composition", () => {
    vi.useFakeTimers();
    const { terminal, emitKey, emitData } = createTerminal();

    attachXtermRawInput(terminal, "sess-1");
    const composingDash = new KeyboardEvent("keydown", { key: "-", isComposing: true });
    const shouldContinue = emitKey(composingDash);
    // composition 未结束, 不模拟 textarea input;直接走 IME commit 路径 → xterm.onData
    emitData("hello-");
    vi.runAllTimers();

    // 关键: composing 时 punctuation 不应被探针拦截, 必须让 xterm 自己接管 (返回 true)
    expect(shouldContinue).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "hello-");
  });

  it("does not start a native text probe while module composition state is active", () => {
    vi.useFakeTimers();
    const { terminal, emitCompositionStart, emitKey, emitData } = createTerminal();

    attachXtermRawInput(terminal, "sess-1", { physicalKeyboardMode: true });
    emitCompositionStart();
    const composingSpace = new KeyboardEvent("keydown", { key: " ", code: "Space" });
    const shouldContinue = emitKey(composingSpace);
    emitData("你好");
    vi.runAllTimers();

    expect(shouldContinue).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "你好");
  });

  it("can map plain Enter to LF for mobile soft-keyboard newline", () => {
    const { terminal, emitKey } = createTerminal();
    const onRawInput = vi.fn();
    const event = new KeyboardEvent("keydown", { key: "Enter" });
    const preventDefault = vi.spyOn(event, "preventDefault");

    attachXtermRawInput(terminal, "sess-1", {
      onRawInput,
      plainEnterBehavior: "linefeed",
    });
    const shouldContinue = emitKey(event);

    expect(shouldContinue).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "\n");
    expect(onRawInput).toHaveBeenCalledWith("\n");
  });

  it("inverts Shift+Enter under linefeed mode so users can still submit (CR)", () => {
    // 移动端 plainEnterBehavior=linefeed：plain Enter 走 \n，Shift+Enter 必须翻转回 submit
    // 语义（落到 xterm 默认 \r）。否则 Shift 在该模式下退化成 no-op，用户没有办法显式提交。
    const { terminal, emitKey } = createTerminal();
    const onRawInput = vi.fn();
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true });
    const preventDefault = vi.spyOn(event, "preventDefault");

    attachXtermRawInput(terminal, "sess-1", {
      onRawInput,
      plainEnterBehavior: "linefeed",
    });
    const shouldContinue = emitKey(event);

    // shouldContinue=true 让 xterm 走默认 Enter 处理（\r）。本层不发 LF、不 preventDefault。
    expect(shouldContinue).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalledWith("sess-1", "\n");
    expect(onRawInput).not.toHaveBeenCalled();
  });
});
