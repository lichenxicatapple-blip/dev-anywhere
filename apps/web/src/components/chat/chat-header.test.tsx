import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadFile, toastError, toastLoading, toastSuccess, sendRawSpy } = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  toastError: vi.fn(),
  toastLoading: vi.fn(() => "loading-id"),
  toastSuccess: vi.fn(),
  sendRawSpy: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { uploadFile },
  wsManagerRef: null,
}));

vi.mock("@/components/toast", () => ({
  toast: {
    error: toastError,
    loading: toastLoading,
    success: toastSuccess,
    dismiss: vi.fn(),
  },
}));

vi.mock("@/lib/ansi-keys", () => ({
  sendRemoteInputRaw: sendRawSpy,
}));

// 路由 / 媒体查询 / store 等的桩
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => false,
}));
vi.mock("@/hooks/use-screen-wake-lock", () => ({
  useScreenWakeLockScope: () => ({
    active: false,
    pending: false,
    supported: true,
    toggle: () => Promise.resolve(),
  }),
}));

import { ChatHeader } from "./chat-header";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";

describe("ChatHeader PTY upload menu", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    uploadFile.mockReset();
    uploadFile.mockResolvedValue({
      sessionId: "s1",
      success: true,
      path: ".dev-anywhere/uploads/s1/notes.txt",
    });
    toastError.mockReset();
    toastSuccess.mockReset();
    toastLoading.mockReset();
    toastLoading.mockReturnValue("loading-id");
    sendRawSpy.mockReset();
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          mode: "pty",
          provider: "claude",
          state: "idle",
          ptyOwner: "local-terminal",
        },
      ],
      ptyTitles: {},
    });
    useAppStore.setState({ ptyFontSize: 14, chatContentFontSize: 14 });
  });

  // Radix DropdownMenu 用 Portal + pointer events, jsdom 下交互复杂。这里跳过菜单 UI,
   // 直接触发 hidden input 的 change—— input 仍由 ChatHeader 渲染出来 (PTY 模式), 测的是
   // 菜单选完文件后的核心 handler: uploadFile 调用 + "@<path> " 写终端。
  function getUploadInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector(
      'input[data-slot="chat-menu-upload-file-input"]',
    ) as HTMLInputElement | null;
    if (!input) throw new Error("hidden upload input not rendered");
    return input;
  }

  it("uploads picked file and writes the @<path> token into the terminal", async () => {
    const { container } = render(<ChatHeader sessionId="s1" mode="pty" />);

    const input = getUploadInput(container);
    const file = new File([new Uint8Array([0x41, 0x42, 0x43])], "notes.txt", {
      type: "text/plain",
    });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect(uploadFile).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ fileName: "notes.txt", mimeType: "text/plain" }),
    );
    await waitFor(() =>
      expect(sendRawSpy).toHaveBeenCalledWith("s1", "@.dev-anywhere/uploads/s1/notes.txt "),
    );
    expect(toastSuccess).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows error toast and does not write to terminal when upload fails", async () => {
    uploadFile.mockResolvedValueOnce({
      sessionId: "s1",
      success: false,
      error: "磁盘满了",
    });

    const { container } = render(<ChatHeader sessionId="s1" mode="pty" />);
    const input = getUploadInput(container);
    const file = new File([new Uint8Array([1])], "x.bin", { type: "application/octet-stream" });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(sendRawSpy).not.toHaveBeenCalled();
  });

  it("does not render the hidden file input in JSON mode", () => {
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
    });
    const { container } = render(<ChatHeader sessionId="s1" mode="json" />);
    expect(
      container.querySelector('input[data-slot="chat-menu-upload-file-input"]'),
    ).toBeNull();
  });
});
