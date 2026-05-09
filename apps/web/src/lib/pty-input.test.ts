import { describe, expect, it, vi, beforeEach } from "vitest";
import { attachXtermRawInput } from "./pty-input";

const sendSpy = vi.fn();
vi.mock("./ansi-keys", () => ({
  sendRemoteInputRaw: (sessionId: string, data: string) => sendSpy(sessionId, data),
}));

describe("attachXtermRawInput", () => {
  beforeEach(() => {
    sendSpy.mockClear();
  });

  function createTerminal() {
    let dataHandler: ((data: string) => void) | undefined;
    let keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
    const disposeSpy = vi.fn();
    const terminal = {
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
      emitData: (data: string) => dataHandler?.(data),
      emitKey: (event: KeyboardEvent) => keyHandler?.(event),
    };
  }

  it.each([
    ["plain text", "abc"],
    ["enter", "\r"],
    ["backspace", "\x7f"],
    ["tab", "\t"],
    ["escape", "\x1b"],
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
});
