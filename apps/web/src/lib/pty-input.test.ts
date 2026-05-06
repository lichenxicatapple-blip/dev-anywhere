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

  it("forwards xterm onData payloads as raw PTY input", () => {
    let handler: ((data: string) => void) | undefined;
    const disposeSpy = vi.fn();
    const terminal = {
      onData: vi.fn((next: (data: string) => void) => {
        handler = next;
        return { dispose: disposeSpy };
      }),
    };

    const disposable = attachXtermRawInput(terminal, "sess-1");
    handler?.("\x1b[A");

    expect(terminal.onData).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("sess-1", "\x1b[A");

    disposable.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
