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
import { ptyAutoYesSessionKey, useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";
import { useVoicePilotStore } from "@/voice/voice-pilot-store";

describe("ChatHeader PTY upload menu", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    sessionStorage.clear();
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
      ptyAutoYesBySessionKey: {},
    });
    useAppStore.setState({
      ptyFontSize: 14,
      chatContentFontSize: 14,
      selectedProxyId: "proxy-1",
    });
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

  it("lets PTY agent sessions toggle Always yes from the overflow menu", async () => {
    const key = ptyAutoYesSessionKey("proxy-1", "s1");
    if (!key) throw new Error("missing PTY auto yes key");
    render(<ChatHeader sessionId="s1" mode="pty" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: "Always yes" });
    fireEvent.click(item);

    expect(useSessionStore.getState().ptyAutoYesBySessionKey[key]).toBe(true);
  });

  it("uploads picked file and writes the @<path> token into the terminal", async () => {
    const { container } = render(<ChatHeader sessionId="s1" mode="pty" />);

    const input = getUploadInput(container);
    const file = new File([new Uint8Array([0x41, 0x42, 0x43])], "notes.txt", {
      type: "text/plain",
    });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect(uploadFile).toHaveBeenCalledWith("s1", file);
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

  it("shows pure terminal cwd until the user renames it", () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "term-1",
          kind: "terminal",
          mode: "pty",
          provider: "claude",
          state: "idle",
          name: "Terminal",
          cwd: "/Users/dev/MyApps/dev-anywhere",
          ptyOwner: "local-terminal",
        },
      ],
      ptyTitles: { "term-1": "Claude Code" },
    });

    const { container } = render(<ChatHeader sessionId="term-1" mode="pty" />);

    expect(container.querySelector('[data-slot="chat-session-title"]')?.textContent).toBe(
      "~/MyApps/dev-anywhere",
    );
  });

  it("keeps a user-renamed pure terminal title over cwd", () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "term-1",
          kind: "terminal",
          mode: "pty",
          provider: "claude",
          state: "idle",
          name: "Release shell",
          nameLocked: true,
          cwd: "/Users/dev/MyApps/dev-anywhere",
          ptyOwner: "local-terminal",
        },
      ],
      ptyTitles: { "term-1": "Claude Code" },
    });

    const { container } = render(<ChatHeader sessionId="term-1" mode="pty" />);

    expect(container.querySelector('[data-slot="chat-session-title"]')?.textContent).toBe(
      "Release shell",
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
    expect(wakeLockItem.querySelector('[data-slot="chat-menu-icon"]')).not.toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "桌面交互模式" })).toBeNull();
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

    expect(await screen.findByRole("dialog")).not.toBeNull();
    expect(screen.getByText("开启后会自动保持屏幕常亮，直到你停止 Voice Pilot。")).not.toBeNull();
    expect(screen.getByText("运行期间不能单独关闭这个常亮状态。")).not.toBeNull();
    expect(screen.getByText("长时间使用可能会显著增加电量消耗和设备发热。")).not.toBeNull();
    expect(useVoicePilotStore.getState().bySessionId.s1?.enabled).not.toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "开启 Voice Pilot" }));

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
    expect(screen.queryByRole("dialog")).toBeNull();
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

    expect(await screen.findByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开启 Voice Pilot" }));

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

    expect(await screen.findByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开启 Voice Pilot" }));

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

  it("shows screen wake lock as controlled while Voice Pilot is running", async () => {
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
    });
    useVoicePilotStore.getState().enable("s1");
    render(<ChatHeader sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const wakeLockItem = await screen.findByRole("menuitemcheckbox", {
      name: "屏幕常亮（Voice Pilot 控制）",
    });
    expect(wakeLockItem.getAttribute("aria-checked")).toBe("true");
    expect(wakeLockItem.getAttribute("aria-disabled")).toBe("true");
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
