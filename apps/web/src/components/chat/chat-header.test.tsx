import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requestVoiceConfig,
  uploadFile,
  toastError,
  toastInfo,
  toastLoading,
  toastSuccess,
  sendRawSpy,
} = vi.hoisted(() => ({
  requestVoiceConfig: vi.fn(),
  uploadFile: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastLoading: vi.fn(() => "loading-id"),
  toastSuccess: vi.fn(),
  sendRawSpy: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { requestVoiceConfig, uploadFile },
  wsManagerRef: null,
}));

vi.mock("@/components/toast", () => ({
  toast: {
    error: toastError,
    info: toastInfo,
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
import { useVoicePilotStore } from "@/voice/voice-pilot-store";

describe("ChatHeader PTY upload menu", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
    requestVoiceConfig.mockReset();
    requestVoiceConfig.mockResolvedValue({
      config: {
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
        turnIdleSeconds: 3,
      },
    });
    uploadFile.mockReset();
    uploadFile.mockResolvedValue({
      sessionId: "s1",
      success: true,
      path: ".dev-anywhere/uploads/s1/notes.txt",
    });
    toastError.mockReset();
    toastSuccess.mockReset();
    toastInfo.mockReset();
    toastLoading.mockReset();
    toastLoading.mockReturnValue("loading-id");
    sendRawSpy.mockReset();
    useVoicePilotStore.getState().resetAll();
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
    expect(container.querySelector('input[data-slot="chat-menu-upload-file-input"]')).toBeNull();
  });

  it("keeps a user-renamed PTY title instead of OSC terminal titles", () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          mode: "pty",
          provider: "claude",
          state: "idle",
          name: "Release checklist",
          nameLocked: true,
          cwd: "/Users/dev/project",
        },
      ],
      ptyTitles: { s1: "✻ Working" },
    });

    const { container } = render(<ChatHeader sessionId="s1" mode="pty" />);

    expect(container.querySelector('[data-slot="chat-session-title"]')?.textContent).toBe(
      "Release checklist",
    );
  });

  it("keeps the overflow menu visually consistent with icons and grouped controls", async () => {
    render(<ChatHeader sessionId="s1" mode="pty" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    menuTrigger.focus();
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const menu = await waitFor(() => {
      const element = document.querySelector('[data-slot="chat-overflow-menu"]');
      if (!(element instanceof HTMLElement)) {
        throw new Error("chat overflow menu was not rendered");
      }
      return element;
    });
    const menuItemNames = ["重命名", "发送 Ctrl+O", "上传图片", "上传文件", "恢复默认"];

    for (const name of menuItemNames) {
      const item = screen.getByRole("menuitem", { name });
      expect(item.querySelector('[data-slot="chat-menu-icon"]')).not.toBeNull();
    }

    const wakeLockItem = screen.getByRole("menuitemcheckbox", { name: "屏幕常亮" });
    expect(menu.className).toContain("w-max");
    expect(menu.className).toContain("min-w-44");
    expect(wakeLockItem.querySelector('[data-slot="chat-menu-icon"]')).not.toBeNull();
    expect(screen.getByText("^O").closest('[data-slot="chat-menu-icon"]')).not.toBeNull();
    expect(menu?.querySelector('[data-slot="chat-menu-font-row"]')).not.toBeNull();
    expect(
      menu?.querySelector('[data-slot="chat-menu-font-row"] [data-slot="chat-menu-icon"]'),
    ).not.toBeNull();
    expect(menu?.querySelector('[data-slot="chat-menu-font-stepper"]')).not.toBeNull();
    expect(screen.getByText("字号")).not.toBeNull();
    expect(screen.queryByText("终端字号")).toBeNull();
    expect(screen.queryByText("聊天字号")).toBeNull();
    expect(screen.queryByText("显示")).toBeNull();
  });

  it("lets JSON sessions toggle Voice Pilot from the overflow menu", async () => {
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
    });
    render(<ChatHeader sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" });
    fireEvent.click(item);

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        enabled: true,
        phase: "starting",
      }),
    );
  });

  it("shows a toast and keeps Voice Pilot disabled when voice settings are missing", async () => {
    requestVoiceConfig.mockResolvedValueOnce({
      config: {
        provider: "aliyun-bailian",
        configured: false,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
        turnIdleSeconds: 3,
      },
    });
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
    });
    render(<ChatHeader sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" });
    fireEvent.click(item);

    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("请先在设置里配置 Voice Pilot。"));
    expect(useVoicePilotStore.getState().bySessionId.s1?.enabled).not.toBe(true);
  });

  it("shows a toast and keeps Voice Pilot disabled when no microphone is available", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          const error = new Error("not found");
          error.name = "NotFoundError";
          throw error;
        }),
      },
    });
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
    });
    render(<ChatHeader sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" });
    fireEvent.click(item);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("未检测到可用麦克风。"));
    expect(useVoicePilotStore.getState().bySessionId.s1?.enabled).not.toBe(true);
  });

  it("shows a toast and keeps Voice Pilot disabled when microphone permission is denied", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          const error = new Error("denied");
          error.name = "NotAllowedError";
          throw error;
        }),
      },
    });
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
    });
    render(<ChatHeader sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" });
    fireEvent.click(item);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("没有麦克风权限，请在浏览器里允许访问麦克风。"),
    );
    expect(useVoicePilotStore.getState().bySessionId.s1?.enabled).not.toBe(true);
  });

  it("can turn off Voice Pilot without rechecking provider config", async () => {
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
    });
    useVoicePilotStore.getState().enable("s1");
    requestVoiceConfig.mockClear();
    render(<ChatHeader sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" });
    fireEvent.click(item);

    await waitFor(() => expect(useVoicePilotStore.getState().bySessionId.s1?.enabled).toBe(false));
    expect(requestVoiceConfig).not.toHaveBeenCalled();
  });

  it("does not show Voice Pilot for PTY sessions", async () => {
    render(<ChatHeader sessionId="s1" mode="pty" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    await waitFor(() => {
      expect(document.querySelector('[data-slot="chat-overflow-menu"]')).not.toBeNull();
    });

    expect(screen.queryByRole("menuitem", { name: "Voice Pilot" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Voice Pilot" })).toBeNull();
    expect(useVoicePilotStore.getState().bySessionId.s1?.enabled).not.toBe(true);
  });

  it("keeps the font-size stepper compact enough for mobile menu width", async () => {
    render(<ChatHeader sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const menu = await waitFor(() => {
      const element = document.querySelector('[data-slot="chat-overflow-menu"]');
      if (!(element instanceof HTMLElement)) {
        throw new Error("chat overflow menu was not rendered");
      }
      return element;
    });
    const row = menu.querySelector('[data-slot="chat-menu-font-row"]');
    const stepper = menu.querySelector('[data-slot="chat-menu-font-stepper"]');
    const larger = menu.querySelector('[data-slot="chat-menu-font-larger"]');

    expect(menu.className).toContain("w-max");
    expect(menu.className).toContain("min-w-44");
    expect(menu.className).not.toContain("w-64");
    expect(row?.className).toContain("inline-grid");
    expect(row?.className).toContain("grid-cols-[1.25rem_auto]");
    expect(menu.querySelector('[data-slot="chat-menu-font-label"]')).toBeNull();
    expect(stepper?.className).toContain("inline-flex");
    expect(stepper?.className).toContain("col-start-2");
    expect(stepper?.className).not.toContain("border");
    expect(larger?.className).toContain("size-6");
  });

  it("keeps the page interactive while the overflow menu is open so mobile outside taps can dismiss it", async () => {
    render(<ChatHeader sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    await waitFor(() => {
      expect(document.querySelector('[data-slot="chat-overflow-menu"]')).not.toBeNull();
    });

    expect(document.body.style.pointerEvents).not.toBe("none");
  });
});
