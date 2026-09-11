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
  prepareVoicePlayback,
  voiceAudioSessionAcquire,
  voiceAudioSessionRelease,
  voicePilotWakeLockEnable,
  voicePilotWakeLockDisable,
  wakeLockState,
} = vi.hoisted(() => ({
  requestVoiceConfig: vi.fn(),
  uploadFile: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastLoading: vi.fn(() => "loading-id"),
  toastSuccess: vi.fn(),
  sendRawSpy: vi.fn(),
  prepareVoicePlayback: vi.fn(),
  voiceAudioSessionAcquire: vi.fn(),
  voiceAudioSessionRelease: vi.fn(),
  voicePilotWakeLockEnable: vi.fn(),
  voicePilotWakeLockDisable: vi.fn(),
  wakeLockState: {
    active: false,
    pending: false,
    supported: true,
    unavailableReason: null as "insecure-context" | "unsupported" | null,
    toggle: vi.fn(async () => undefined),
  },
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
  useScreenWakeLockScope: () => wakeLockState,
}));
vi.mock("@/voice/voice-playback-context", () => ({
  voicePlaybackContext: {
    prepare: prepareVoicePlayback,
  },
}));
vi.mock("@/voice/browser-audio-session", () => ({
  voiceAudioSession: {
    acquire: voiceAudioSessionAcquire,
  },
}));
vi.mock("@/lib/screen-wake-lock-manager", () => ({
  screenWakeLockManager: {
    enable: voicePilotWakeLockEnable,
    disable: voicePilotWakeLockDisable,
  },
}));

import { ChatHeader } from "./chat-header";
import { ptyAutoYesSessionKey, useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";
import { useFileStore } from "@/stores/file-store";
import { useVoicePilotStore } from "@/voice/voice-pilot-store";

describe("ChatHeader PTY upload menu", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    useFileStore.setState({ homePath: "/Users/dev" });
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
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
    prepareVoicePlayback.mockReset();
    prepareVoicePlayback.mockResolvedValue({});
    voiceAudioSessionAcquire.mockReset();
    voiceAudioSessionRelease.mockReset();
    voiceAudioSessionAcquire.mockReturnValue({
      setMode: vi.fn(),
      release: voiceAudioSessionRelease,
    });
    voicePilotWakeLockEnable.mockReset();
    voicePilotWakeLockEnable.mockResolvedValue(undefined);
    voicePilotWakeLockDisable.mockReset();
    voicePilotWakeLockDisable.mockResolvedValue(undefined);
    Object.assign(wakeLockState, {
      active: false,
      pending: false,
      supported: true,
      unavailableReason: null,
    });
    wakeLockState.toggle.mockClear();
    useVoicePilotStore.getState().resetAll();
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "pty",
          provider: "claude",
          state: "idle",
          ptyOwner: "local-terminal",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
      ptyTitles: {},
      ptyGeometryBySessionId: { s1: { cols: 80, rows: 24 } },
      ptyAutoYesBySessionKey: {},
    });
    useAppStore.setState({
      ptyFontSize: 14,
      chatContentFontSize: 14,
      selectedProxyId: "proxy-1",
      connected: true,
      proxyOnline: true,
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

  it.each([false, true])("renders and toggles Always yes when enabled=%s", async (enabled) => {
    const key = ptyAutoYesSessionKey("proxy-1", "s1");
    if (!key) throw new Error("missing PTY auto yes key");
    useSessionStore.getState().setPtyAutoYes(key, enabled);
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: "Always yes" });
    expect(item).toHaveAttribute("aria-checked", String(enabled));
    expect(item.querySelectorAll(".lucide-check")).toHaveLength(enabled ? 1 : 0);
    fireEvent.click(item);

    expect(useSessionStore.getState().ptyAutoYesBySessionKey[key]).toBe(enabled ? undefined : true);
  });

  it("hides Always yes for Codex even with an existing grant", async () => {
    const key = ptyAutoYesSessionKey("proxy-1", "s1")!;
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.kind === "agent" ? { ...session, provider: "codex" } : session,
      ),
      ptyAutoYesBySessionKey: { [key]: true },
    }));
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);
    fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
    await screen.findByRole("menuitem", { name: "重命名" });
    expect(screen.queryByRole("menuitemcheckbox", { name: /Always yes/ })).toBeNull();
  });

  it.each(["agent", "terminal"] as const)("offers manual fit for a hosted %s PTY", async (kind) => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind,
          mode: "pty",
          provider: "claude",
          cwd: "/tmp/project",
          ptyOwner: "proxy-hosted",
          state: "idle",
          lastActive: 1,
        },
      ],
    });
    useAppStore.setState({ connected: true, proxyOnline: true });
    const fit = vi.fn();
    render(<ChatHeader sessionId="s1" mode="pty" onFind={() => {}} onResizeTerminal={fit} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "增加列" }));
    fireEvent.click(screen.getByRole("button", { name: "增加列" }));
    fireEvent.click(screen.getByRole("button", { name: "增加行" }));
    fireEvent.click(screen.getByRole("button", { name: "减少列" }));
    fireEvent.click(screen.getByRole("button", { name: "减少行" }));
    expect(fit.mock.calls).toEqual([
      ["increase-cols"],
      ["increase-cols"],
      ["increase-rows"],
      ["decrease-cols"],
      ["decrease-rows"],
    ]);
    expect(screen.getByRole("group", { name: "列数" })).toHaveTextContent("80");
    expect(screen.getByRole("group", { name: "行数" })).toHaveTextContent("24");
    fit.mockClear();
    fireEvent.click(await screen.findByRole("menuitem", { name: "按窗口调整终端尺寸" }));
    expect(fit).toHaveBeenCalledExactlyOnceWith("fit");
  });

  it("does not offer manual fit for a locally owned PTY", async () => {
    render(<ChatHeader sessionId="s1" mode="pty" onFind={() => {}} onResizeTerminal={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
    await screen.findByRole("menuitem", { name: "重命名" });
    expect(screen.queryByRole("menuitem", { name: "按窗口调整终端尺寸" })).toBeNull();
    expect(screen.queryByRole("group", { name: "列数" })).toBeNull();
    expect(screen.queryByRole("group", { name: "行数" })).toBeNull();
  });

  it("prevents a fit command while the developer machine is offline", async () => {
    useSessionStore.setState({
      sessions: [
        { ...useSessionStore.getState().sessions[0]!, mode: "pty", ptyOwner: "proxy-hosted" },
      ],
    });
    useAppStore.setState({ connected: true, proxyOnline: false });
    const fit = vi.fn();
    render(<ChatHeader sessionId="s1" mode="pty" onFind={() => {}} onResizeTerminal={fit} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
    const item = await screen.findByRole("menuitem", { name: "按窗口调整终端尺寸" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    for (const name of ["增加列", "增加行", "减少列", "减少行"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(fit).not.toHaveBeenCalled();
  });

  it.each([
    [{ cols: 2, rows: 1 }, ["减少列", "减少行"], ["增加列", "增加行"]],
    [{ cols: 500, rows: 200 }, ["增加列", "增加行"], ["减少列", "减少行"]],
    [undefined, ["增加列", "增加行", "减少列", "减少行"], []],
  ] as const)(
    "disables unavailable size adjustments for %s",
    async (geometry, disabled, enabled) => {
      useSessionStore.setState({
        sessions: [
          { ...useSessionStore.getState().sessions[0]!, mode: "pty", ptyOwner: "proxy-hosted" },
        ],
        ptyGeometryBySessionId: geometry ? { s1: geometry } : {},
      });
      useAppStore.setState({ connected: true, proxyOnline: true });
      render(<ChatHeader sessionId="s1" mode="pty" onFind={() => {}} onResizeTerminal={vi.fn()} />);
      fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
      await screen.findByRole("group", { name: "列数" });
      for (const name of disabled) expect(screen.getByRole("button", { name })).toBeDisabled();
      for (const name of enabled) expect(screen.getByRole("button", { name })).toBeEnabled();
    },
  );

  it("uploads picked file and writes the @<path> token into the terminal", async () => {
    const { container } = render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);

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

    const { container } = render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);
    const input = getUploadInput(container);
    const file = new File([new Uint8Array([1])], "x.bin", { type: "application/octet-stream" });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(sendRawSpy).not.toHaveBeenCalled();
  });

  it("does not render the hidden file input in JSON mode", () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    const { container } = render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);
    expect(container.querySelector('input[data-slot="chat-menu-upload-file-input"]')).toBeNull();
  });

  it("keeps a user-renamed PTY title instead of OSC terminal titles", () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "pty",
          provider: "claude",
          state: "idle",
          name: "Release checklist",
          nameLocked: true,
          cwd: "/Users/dev/project",
          ptyOwner: "local-terminal",
          lastActive: 1,
        },
      ],
      ptyTitles: { s1: "✻ Working" },
    });

    const { container } = render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);

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
          ptyOwner: "proxy-hosted",
          lastActive: 1,
        },
      ],
      ptyTitles: { "term-1": "Claude Code" },
    });

    const { container } = render(<ChatHeader onFind={() => {}} sessionId="term-1" mode="pty" />);

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
          ptyOwner: "proxy-hosted",
          lastActive: 1,
        },
      ],
      ptyTitles: { "term-1": "Claude Code" },
    });

    const { container } = render(<ChatHeader onFind={() => {}} sessionId="term-1" mode="pty" />);

    expect(container.querySelector('[data-slot="chat-session-title"]')?.textContent).toBe(
      "Release shell",
    );
  });

  it("keeps the overflow menu visually consistent with icons and grouped controls", async () => {
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);

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
    const menuItemNames = [
      "在会话中查找",
      "重命名",
      "快捷键",
      "上传照片或视频",
      "上传文件",
      "恢复默认",
    ];

    for (const name of menuItemNames) {
      const item = screen.getByRole("menuitem", { name });
      expect(item.querySelector('[data-slot="chat-menu-icon"]')).not.toBeNull();
    }

    const wakeLockItem = screen.getByRole("menuitemcheckbox", { name: "屏幕常亮" });
    expect(wakeLockItem.querySelector('[data-slot="chat-menu-icon"]')).not.toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "输入方式" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "发送 Ctrl+O" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "发送 Ctrl+R" })).toBeNull();
    expect(menu?.querySelector('[data-slot="chat-menu-font-row"]')).not.toBeNull();
    expect(
      menu?.querySelector('[data-slot="chat-menu-font-row"] [data-slot="chat-menu-icon"]'),
    ).not.toBeNull();
    expect(menu?.querySelector('[data-slot="chat-menu-font-stepper"]')).not.toBeNull();
    expect(screen.getByText("字号")).not.toBeNull();
    expect(screen.queryByText("终端字号")).toBeNull();
    expect(screen.queryByText("聊天字号")).toBeNull();
    expect(screen.queryByText("显示")).toBeNull();

    await openShortcutsMenu();
    expect(screen.getByText("^O").closest('[data-slot="chat-menu-icon"]')).not.toBeNull();
    expect(screen.getByText("^R").closest('[data-slot="chat-menu-icon"]')).not.toBeNull();
  });

  async function openShortcutsMenu() {
    const trigger = await screen.findByRole("menuitem", { name: "快捷键" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    await screen.findByRole("menuitem", { name: "发送 Ctrl+O" });
  }

  function renderHeaderWithPtyFocus(
    options: {
      mode?: "pty" | "json";
      inputSessionId?: string;
      active?: boolean;
    } = {},
  ) {
    const { mode = "pty", inputSessionId = "s1", active = true } = options;
    render(
      <>
        <ChatHeader
          sessionId="s1"
          mode={mode}
          onFind={() => {
            requestAnimationFrame(() => screen.getByLabelText("测试查找").focus());
          }}
        />
        <input aria-label="测试查找" />
        <div
          data-slot="pty-keepalive-entry"
          data-session-id={inputSessionId}
          data-active={String(active)}
        >
          <div data-slot="pty-host">
            <textarea aria-label="Terminal input" className="xterm-helper-textarea" />
          </div>
        </div>
      </>,
    );
    return {
      input: screen.getByLabelText("Terminal input"),
      trigger: screen.getByRole("button", { name: "会话操作" }),
    };
  }

  async function openMenuWithPointer(trigger: HTMLElement) {
    // jsdom has no native PointerEvent; a MouseEvent with the pointerdown type supplies the
    // button/ctrlKey fields Radix uses while exercising React's real capture/bubble handlers.
    fireEvent(trigger, new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    return screen.findByRole("menu");
  }

  it("returns Escape dismissal to the current PTY input after opening the menu with a pointer", async () => {
    const { input, trigger } = renderHeaderWithPtyFocus();
    input.focus();
    const menu = await openMenuWithPointer(trigger);
    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(input).toHaveFocus());
    expect(sendRawSpy).not.toHaveBeenCalled();
  });

  it("keeps keyboard navigation focus on the menu trigger after Escape", async () => {
    const { input, trigger } = renderHeaderWithPtyFocus();
    input.focus();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(["json", "other-session", "inactive"] as const)(
    "does not restore PTY focus from an unrelated %s input",
    async (scenario) => {
      if (scenario === "json") {
        useSessionStore.setState({
          sessions: [
            {
              sessionId: "s1",
              kind: "agent",
              mode: "json",
              provider: "claude",
              state: "idle",
              cwd: "/tmp/project",
              lastActive: 1,
            },
          ],
        });
      }
      const { input, trigger } = renderHeaderWithPtyFocus({
        mode: scenario === "json" ? "json" : "pty",
        inputSessionId: scenario === "other-session" ? "other-session" : "s1",
        active: scenario !== "inactive",
      });
      input.focus();
      fireEvent.keyDown(await openMenuWithPointer(trigger), { key: "Escape" });

      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      await waitFor(() => expect(trigger).toHaveFocus());
    },
  );

  it.each(["在会话中查找", "重命名"])(
    "does not restore PTY focus when selecting %s",
    async (action) => {
      const { input, trigger } = renderHeaderWithPtyFocus();
      input.focus();
      await openMenuWithPointer(trigger);
      fireEvent.click(screen.getByRole("menuitem", { name: action }));

      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      const destination = await screen.findByLabelText(
        action === "重命名" ? "会话标题" : "测试查找",
      );
      await waitFor(() => expect(destination).toHaveFocus());
      expect(input).not.toHaveFocus();
    },
  );

  it("leaves focus on an outside control that dismisses the PTY menu", async () => {
    const { input, trigger } = renderHeaderWithPtyFocus();
    input.focus();
    await openMenuWithPointer(trigger);
    const outside = screen.getByLabelText("测试查找");
    fireEvent(outside, new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    outside.focus();

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(outside).toHaveFocus());
  });

  it.each(["agent", "terminal"] as const)(
    "sends Ctrl+R to %s PTY sessions from the shared overflow menu",
    async (kind) => {
      useSessionStore.setState({
        sessions: [
          {
            sessionId: "s1",
            kind,
            mode: "pty",
            provider: "claude",
            state: "idle",
            ptyOwner: "proxy-hosted",
            cwd: "/tmp/project",
            lastActive: 1,
          },
        ],
      });
      render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);

      fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
      await openShortcutsMenu();
      const item = await screen.findByRole("menuitem", { name: "发送 Ctrl+R" });
      expect(item).not.toHaveAttribute("aria-disabled", "true");
      if (kind === "terminal") {
        item.focus();
        fireEvent.keyDown(item, { key: "Enter" });
      } else {
        fireEvent.click(item);
      }

      expect(sendRawSpy).toHaveBeenCalledExactlyOnceWith("s1", "\x12");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      sendRawSpy.mockClear();
      fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
      await openShortcutsMenu();
      fireEvent.click(await screen.findByRole("menuitem", { name: "发送 Ctrl+O" }));
      expect(sendRawSpy).toHaveBeenCalledExactlyOnceWith("s1", "\x0f");
    },
  );

  it.each(["disconnected", "proxy-offline", "session-error"])(
    "does not send Ctrl+R when %s",
    async (status) => {
      if (status === "disconnected") useAppStore.setState({ connected: false });
      if (status === "proxy-offline") useAppStore.setState({ proxyOnline: false });
      if (status === "session-error") {
        useSessionStore.setState({
          sessions: useSessionStore.getState().sessions.map((session) => ({
            ...session,
            state: "error",
          })),
        });
      }
      render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);

      fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
      await openShortcutsMenu();
      const item = await screen.findByRole("menuitem", { name: "发送 Ctrl+R" });
      expect(item).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(item);
      expect(sendRawSpy).not.toHaveBeenCalled();
    },
  );

  it("does not offer Ctrl+R for JSON chat sessions", async () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

    fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "快捷键" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "发送 Ctrl+R" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "发送 Ctrl+O" })).toBeNull();
  });

  function configureCodexQuestionSession(
    ptyOwner: "local-terminal" | "proxy-hosted" = "local-terminal",
    state: "working" | "error" = "working",
  ) {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "pty",
          provider: "codex",
          state,
          ptyOwner,
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
      ptyAutoYesBySessionKey: { [ptyAutoYesSessionKey("proxy-1", "s1")!]: true },
    });
  }

  it.each(["local-terminal", "proxy-hosted"] as const)(
    "sends manual Codex question shortcuts while %s is working and Always yes is hidden",
    async (ptyOwner) => {
      configureCodexQuestionSession(ptyOwner);
      render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);

      for (const [name, data] of [
        ["发送 Alt+↑", "\x1b[1;3A"],
        ["发送 Alt+↓", "\x1b[1;3B"],
        ["发送 Ctrl+]", "\x1d"],
      ]) {
        sendRawSpy.mockClear();
        fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
        await openShortcutsMenu();
        const item = await screen.findByRole("menuitem", { name });
        expect(item).not.toHaveAttribute("aria-disabled", "true");
        expect(item.querySelector('[data-slot="chat-menu-icon"] .lucide-keyboard')).not.toBeNull();
        if (ptyOwner === "local-terminal") fireEvent.click(item);
        else {
          item.focus();
          fireEvent.keyDown(item, { key: "Enter" });
        }
        expect(sendRawSpy).toHaveBeenCalledExactlyOnceWith("s1", data);
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      }
    },
  );

  it.each(["claude", "kimi", "terminal", "codex-json"] as const)(
    "does not offer Codex question shortcuts for %s sessions",
    async (kind) => {
      useSessionStore.setState({
        sessions: [
          kind === "codex-json"
            ? {
                sessionId: "s1",
                kind: "agent",
                mode: "json",
                provider: "codex",
                state: "working",
                cwd: "/tmp/project",
                lastActive: 1,
              }
            : kind === "terminal"
              ? {
                  sessionId: "s1",
                  kind: "terminal",
                  mode: "pty",
                  provider: "claude",
                  state: "working",
                  ptyOwner: "proxy-hosted",
                  cwd: "/tmp/project",
                  lastActive: 1,
                }
              : {
                  sessionId: "s1",
                  kind: "agent",
                  mode: "pty",
                  provider: kind,
                  state: "working",
                  ptyOwner: "local-terminal",
                  cwd: "/tmp/project",
                  lastActive: 1,
                },
        ],
      });
      render(
        <ChatHeader
          onFind={() => {}}
          sessionId="s1"
          mode={kind === "codex-json" ? "json" : "pty"}
        />,
      );
      fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
      await screen.findByRole("menu");
      if (kind !== "codex-json") await openShortcutsMenu();
      expect(document.querySelector('[data-slot^="chat-menu-codex-question-"]')).toBeNull();
    },
  );

  it.each(["disconnected", "proxy-offline", "session-error"] as const)(
    "does not send Codex question shortcuts when %s",
    async (status) => {
      configureCodexQuestionSession(
        "local-terminal",
        status === "session-error" ? "error" : "working",
      );
      if (status === "disconnected") useAppStore.setState({ connected: false });
      if (status === "proxy-offline") useAppStore.setState({ proxyOnline: false });
      render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);
      fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
      await openShortcutsMenu();

      for (const name of ["发送 Alt+↑", "发送 Alt+↓", "发送 Ctrl+]"]) {
        const item = screen.getByRole("menuitem", { name });
        expect(item).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(item);
      }
      expect(sendRawSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["insecure-context", "屏幕常亮（需要 HTTPS）"],
    ["unsupported", "屏幕常亮（浏览器不支持）"],
  ] as const)("explains why screen wake lock is unavailable: %s", async (reason, label) => {
    wakeLockState.supported = false;
    wakeLockState.unavailableReason = reason;
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    menuTrigger.focus();
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: label });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("opens session search from the overflow menu", async () => {
    const onFind = vi.fn();
    render(<ChatHeader onFind={onFind} sessionId="s1" mode="json" />);

    fireEvent.keyDown(screen.getByRole("button", { name: "会话操作" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "在会话中查找" }));

    expect(onFind).toHaveBeenCalledTimes(1);
  });

  it("lets JSON sessions toggle Voice Pilot from the overflow menu", async () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" });
    fireEvent.click(item);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(screen.getByText("开启后会持续聆听并保持屏幕常亮，停止后自动恢复。")).not.toBeNull();
    expect(useVoicePilotStore.getState().bySessionId.s1?.enabled).not.toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "开启 Voice Pilot" }));

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        enabled: true,
        phase: "starting",
      }),
    );
    expect(prepareVoicePlayback).toHaveBeenCalledTimes(1);
    expect(voiceAudioSessionAcquire).toHaveBeenCalledWith("capture");
    expect(voiceAudioSessionRelease).toHaveBeenCalledTimes(1);
    expect(voicePilotWakeLockEnable).toHaveBeenCalledWith("voice-pilot:s1");
    expect(voicePilotWakeLockDisable).not.toHaveBeenCalled();
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
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

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
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" });
    fireEvent.click(item);

    expect(await screen.findByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开启 Voice Pilot" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("未检测到可用麦克风。"));
    expect(useVoicePilotStore.getState().bySessionId.s1?.enabled).not.toBe(true);
    expect(voiceAudioSessionRelease).toHaveBeenCalledTimes(1);
    expect(voicePilotWakeLockDisable).toHaveBeenCalledWith("voice-pilot:s1");
  });

  it("does not request microphone permission when the development voice fixture is selected", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error("fixture startup must not access the microphone");
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    window.history.replaceState({}, "", "/?voice-fixture=default");
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" }));
    fireEvent.click(await screen.findByRole("button", { name: "开启 Voice Pilot" }));

    await waitFor(() =>
      expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
        enabled: true,
        phase: "starting",
      }),
    );
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("requests Voice Pilot wake lock from the confirmation click and rolls back denial", async () => {
    voicePilotWakeLockEnable.mockRejectedValueOnce(
      new DOMException("Permission was denied", "NotAllowedError"),
    );
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" }));
    fireEvent.click(await screen.findByRole("button", { name: "开启 Voice Pilot" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("屏幕常亮请求被浏览器拒绝，Voice Pilot 未开启。"),
    );
    expect(useVoicePilotStore.getState().bySessionId.s1?.enabled).not.toBe(true);
    expect(voicePilotWakeLockDisable).toHaveBeenCalledWith("voice-pilot:s1");
  });

  it("leaves the starting state when wake lock fails while microphone access is pending", async () => {
    voicePilotWakeLockEnable.mockRejectedValueOnce(
      new DOMException("Permission was denied", "NotAllowedError"),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(() => new Promise<MediaStream>(() => undefined)),
      },
    });
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" }));
    fireEvent.click(await screen.findByRole("button", { name: "开启 Voice Pilot" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("屏幕常亮请求被浏览器拒绝，Voice Pilot 未开启。"),
    );
    expect(screen.getByRole("button", { name: "开启 Voice Pilot" })).not.toBeDisabled();
    expect(voiceAudioSessionRelease).toHaveBeenCalledTimes(1);
    expect(voicePilotWakeLockDisable).toHaveBeenCalledWith("voice-pilot:s1");
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
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

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
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    useVoicePilotStore.getState().enable("s1");
    requestVoiceConfig.mockClear();
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const item = await screen.findByRole("menuitemcheckbox", { name: "Voice Pilot" });
    fireEvent.click(item);

    await waitFor(() => expect(useVoicePilotStore.getState().bySessionId.s1?.enabled).toBe(false));
    expect(requestVoiceConfig).not.toHaveBeenCalled();
  });

  it("shows screen wake lock as controlled while Voice Pilot is running", async () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
    });
    useVoicePilotStore.getState().enable("s1");
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const wakeLockItem = await screen.findByRole("menuitemcheckbox", {
      name: "屏幕常亮（Voice Pilot 控制）",
    });
    expect(wakeLockItem.getAttribute("aria-checked")).toBe("true");
    expect(wakeLockItem.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not show Voice Pilot for PTY sessions", async () => {
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="pty" />);

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
    render(<ChatHeader onFind={() => {}} sessionId="s1" mode="json" />);

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    await waitFor(() => {
      expect(document.querySelector('[data-slot="chat-overflow-menu"]')).not.toBeNull();
    });

    expect(document.body.style.pointerEvents).not.toBe("none");
  });
});
