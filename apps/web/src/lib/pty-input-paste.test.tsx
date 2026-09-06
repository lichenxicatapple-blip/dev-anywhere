import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { useTerminalPaste } from "@/components/chat/use-terminal-paste";
import { attachXtermRawInput } from "./pty-input";

const { sendRawInput, uploadImage, uploadFile } = vi.hoisted(() => ({
  sendRawInput: vi.fn(),
  uploadImage: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("./ansi-keys", () => ({ sendRemoteInputRaw: sendRawInput }));
vi.mock("@/lib/clipboard-image-upload", () => ({ uploadClipboardImageFromPaste: uploadImage }));
vi.mock("@/lib/file-upload-payload", () => ({ uploadFileAndShowToast: uploadFile }));
vi.mock("@/hooks/use-relay-setup", () => ({ relayClientRef: {} }));
vi.mock("@/components/toast", () => ({
  toast: { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn() },
}));

const CLIENTS = {
  windows: {
    platform: "Win32",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
  },
  mac: {
    platform: "MacIntel",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15",
  },
  linux: {
    platform: "Linux x86_64",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
  },
  android: {
    platform: "Linux armv8l",
    userAgent:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/150.0.0.0 Mobile Safari/537.36",
  },
  ipad: {
    platform: "MacIntel",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1",
  },
} as const;

describe("PTY browser clipboard and xterm keyboard routing", () => {
  const disposables: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dispose of disposables.splice(0)) dispose();
    cleanup();
    vi.restoreAllMocks();
  });

  function openTerminal(client: keyof typeof CLIENTS, physicalKeyboardMode = true): Terminal {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(CLIENTS[client].userAgent);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(CLIENTS[client].platform);
    const terminal = new Terminal({ allowProposedApi: true });
    const terminalRef = { current: terminal };
    const { result } = renderHook(() => useTerminalPaste({ sessionId: "s1", terminalRef }));
    const view = render(
      <div onPasteCapture={result.current}>
        <div data-testid="terminal" />
      </div>,
    );
    terminal.open(view.getByTestId("terminal"));
    const input = attachXtermRawInput(terminal, "s1", { physicalKeyboardMode });
    disposables.push(() => {
      input.dispose();
      terminal.dispose();
    });
    return terminal;
  }

  function pressKey(terminal: Terminal, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    terminal.textarea!.dispatchEvent(event);
    return event;
  }

  function paste(terminal: Terminal, text: string, files: File[] = []): void {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text/plain" ? text : ""),
        files,
        items: files.map((file) => ({
          kind: "file",
          type: file.type,
          getAsFile: () => file,
        })),
      },
    });
    terminal.textarea!.dispatchEvent(event);
  }

  it.each([true, false])(
    "Windows Ctrl+V leaves the browser paste event available without sending remote Ctrl+V (physical=%s)",
    async (physicalKeyboardMode) => {
      const terminal = openTerminal("windows", physicalKeyboardMode);
      await new Promise<void>((resolve) => terminal.write("\x1b[?2004h", resolve));

      const key = pressKey(terminal, { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true });

      expect(sendRawInput).not.toHaveBeenCalled();
      expect(key.defaultPrevented).toBe(false);
      // jsdom does not synthesize the browser's default paste; deliver its actual clipboard data.
      paste(terminal, "Windows text\nsecond line");

      expect(sendRawInput).toHaveBeenCalledExactlyOnceWith(
        "s1",
        "\x1b[200~Windows text\rsecond line\x1b[201~",
      );
      expect(uploadImage).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["windows", true],
    ["linux", false],
    ["linux", true],
    ["android", false],
  ] as const)("%s Ctrl+V (shift=%s) pastes client text once", (client, shiftKey) => {
    const terminal = openTerminal(client);
    const key = pressKey(terminal, {
      key: shiftKey ? "V" : "v",
      code: "KeyV",
      keyCode: 86,
      ctrlKey: true,
      shiftKey,
    });

    expect(key.defaultPrevented).toBe(false);
    expect(sendRawInput).not.toHaveBeenCalled();
    paste(terminal, "client clipboard");
    expect(sendRawInput).toHaveBeenCalledExactlyOnceWith("s1", "client clipboard");
  });

  it.each(["mac", "ipad"] as const)("%s uses Cmd+V for browser clipboard data", (client) => {
    const terminal = openTerminal(client);
    const key = pressKey(terminal, { key: "v", code: "KeyV", keyCode: 86, metaKey: true });

    expect(key.defaultPrevented).toBe(false);
    expect(sendRawInput).not.toHaveBeenCalled();
    paste(terminal, "Apple clipboard");
    expect(sendRawInput).toHaveBeenCalledExactlyOnceWith("s1", "Apple clipboard");
  });

  it("keeps Mac Ctrl+V available to the remote terminal", () => {
    const terminal = openTerminal("mac");
    pressKey(terminal, { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true });
    expect(sendRawInput).toHaveBeenCalledExactlyOnceWith("s1", "\x16");
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it("keeps Windows Ctrl+C as a terminal interrupt", () => {
    const terminal = openTerminal("windows");
    pressKey(terminal, { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true });
    expect(sendRawInput).toHaveBeenCalledExactlyOnceWith("s1", "\x03");
  });

  it("uploads an actual Windows clipboard image instead of sending a remote clipboard shortcut", async () => {
    const terminal = openTerminal("windows");
    const image = new File(["image bytes"], "browser.png", { type: "image/png" });
    uploadImage.mockResolvedValueOnce({ pathMention: "@uploads/browser.png " });
    pressKey(terminal, { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true });
    paste(terminal, "", [image]);
    await vi.waitFor(() => {
      expect(sendRawInput).toHaveBeenCalledExactlyOnceWith("s1", "@uploads/browser.png ");
    });
    expect(uploadImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ clipboardData: expect.objectContaining({ files: [image] }) }),
    );
  });

  it.each(["android", "ipad"] as const)(
    "%s touch/menu paste still uses xterm newline normalization without a keyboard shortcut",
    (client) => {
      const terminal = openTerminal(client, false);
      paste(terminal, "touch clipboard\nnext line");
      expect(sendRawInput).toHaveBeenCalledExactlyOnceWith("s1", "touch clipboard\rnext line");
      expect(uploadImage).not.toHaveBeenCalled();
    },
  );
});
