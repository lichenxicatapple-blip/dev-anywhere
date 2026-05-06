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
  ])("forwards %s xterm onData payloads as raw PTY input", (_label, data) => {
    let handler: ((data: string) => void) | undefined;
    const disposeSpy = vi.fn();
    const terminal = {
      onData: vi.fn((next: (data: string) => void) => {
        handler = next;
        return { dispose: disposeSpy };
      }),
    };

    const disposable = attachXtermRawInput(terminal, "sess-1");
    handler?.(data);

    expect(terminal.onData).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", data);

    disposable.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
