import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  sendControl,
  onMessage,
  createSession,
  createDirectory,
  requestDirectoryList,
  requestProxyInfo,
  updateAgentCliPath,
  toastError,
  toastSuccess,
  navigateMock,
} = vi.hoisted(() => ({
  sendControl: vi.fn(),
  onMessage: vi.fn(),
  createSession: vi.fn(),
  createDirectory: vi.fn(),
  requestDirectoryList: vi.fn(),
  requestProxyInfo: vi.fn(),
  updateAgentCliPath: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    sendControl,
    onMessage,
    createSession,
    createDirectory,
    requestDirectoryList,
    requestProxyInfo,
    updateAgentCliPath,
  },
  wsManagerRef: null,
}));

vi.mock("@/components/toast", () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}));

import { useFileStore } from "@/stores/file-store";
import { useSessionStore } from "@/stores/session-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CreateSessionDialog } from "./create-session-dialog";

const availableAgentCli = {
  claude: {
    available: true,
    command: "/usr/local/bin/claude",
    suggestions: ["/usr/local/bin/claude", "/home/dev/.local/bin/claude"],
  },
  codex: { available: true, command: "/usr/local/bin/codex" },
  kimi: {
    available: true,
    command: "/usr/local/bin/kimi",
    suggestions: ["/usr/local/bin/kimi", "/home/dev/.local/bin/kimi"],
  },
};

const sessionCreatePermissionCases = [
  ["Claude", "pty", "claude", "严格审批", "default"],
  ["Claude", "pty", "claude", "自动判定", "auto"],
  ["Claude", "pty", "claude", "自动接受编辑", "acceptEdits"],
  ["Claude", "pty", "claude", "只读规划", "plan"],
  ["Claude", "pty", "claude", "跳过全部审批", "bypassPermissions"],
  ["Claude", "json", "claude", "严格审批", "default"],
  ["Claude", "json", "claude", "自动判定", "auto"],
  ["Claude", "json", "claude", "自动接受编辑", "acceptEdits"],
  ["Claude", "json", "claude", "只读规划", "plan"],
  ["Claude", "json", "claude", "跳过全部审批", "bypassPermissions"],
  ["Codex", "pty", "codex", "按需审批", "auto"],
  ["Codex", "pty", "codex", "跳过全部审批", "bypassPermissions"],
  ["Codex", "json", "codex", "按需审批", "auto"],
  ["Codex", "json", "codex", "跳过全部审批", "bypassPermissions"],
  ["Kimi Code", "pty", "kimi", "手工审批", "default"],
  ["Kimi Code", "pty", "kimi", "自动审批", "auto"],
  ["Kimi Code", "pty", "kimi", "只读规划", "plan"],
  ["Kimi Code", "pty", "kimi", "全自动", "bypassPermissions"],
  ["Kimi Code", "json", "kimi", "手工审批", "default"],
  ["Kimi Code", "json", "kimi", "自动审批", "auto"],
  ["Kimi Code", "json", "kimi", "只读规划", "plan"],
  ["Kimi Code", "json", "kimi", "全自动", "bypassPermissions"],
] as const;

type TestViewport = "desktop" | "mobile";
let testViewport: TestViewport = "desktop";

function testMatchMedia(query: string): MediaQueryList {
  const matches =
    query === "(min-width: 768px)"
      ? testViewport === "desktop"
      : query === "(pointer: coarse), (hover: none)"
        ? testViewport === "mobile"
        : false;
  return {
    matches,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  } as MediaQueryList;
}

function renderDialog() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <CreateSessionDialog open onOpenChange={vi.fn()} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function selectAgentCli(label: "Claude Code" | "Codex" | "Kimi Code"): void {
  fireEvent.click(screen.getByRole("combobox", { name: "Agent CLI" }));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("CreateSessionDialog", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    testViewport = "desktop";
    vi.spyOn(window, "matchMedia").mockImplementation(testMatchMedia);
    sendControl.mockClear();
    onMessage.mockReset();
    onMessage.mockReturnValue(vi.fn());
    createSession.mockReset();
    createDirectory.mockReset();
    requestDirectoryList.mockReset();
    requestDirectoryList.mockImplementation(
      async (path: string, options?: { includeHidden?: boolean }) => ({
        path,
        entries: [],
        includeHidden: options?.includeHidden ?? false,
      }),
    );
    requestProxyInfo.mockReset();
    requestProxyInfo.mockResolvedValue({ homePath: "/home/dev", agentCli: availableAgentCli });
    updateAgentCliPath.mockReset();
    toastError.mockClear();
    toastSuccess.mockClear();
    navigateMock.mockClear();
    useFileStore.setState({
      tree: new Map(),
      treeWithHidden: new Map([["/home/dev/.local/bin", [{ name: "claude", isDir: false }]]]),
      cwd: "",
      homePath: "",
      agentCli: null,
    });
    useSessionStore.setState({
      sessions: [],
      sessionListLoaded: false,
      historySessions: [],
      ptyTitles: {},
      ptyStateBySessionId: {},
      agentStatusBySessionId: {},
    });
  });

  it("shows Agent CLI providers as name-only dropdown options", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("combobox", { name: "Agent CLI" }));

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Claude Code",
      "Codex",
      "Kimi Code",
    ]);
  });

  it("keeps initial focus inside the dialog without focusing a form field", async () => {
    const { getByRole } = renderDialog();

    const dialog = getByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(document.activeElement).not.toBe(getByRole("textbox", { name: "工作目录" }));
  });

  it("requests proxy_info when opened without a cached homePath", async () => {
    renderDialog();

    await waitFor(() => {
      expect(requestProxyInfo).toHaveBeenCalled();
      expect(useFileStore.getState().homePath).toBe("/home/dev");
      expect(useFileStore.getState().agentCli).toEqual(availableAgentCli);
    });
  });

  it("uses homePath as the default working directory when it is already cached", async () => {
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByLabelText } = renderDialog();

    await waitFor(() => {
      expect((getByLabelText("工作目录") as HTMLInputElement).value).toBe("/home/dev");
    });
  });

  it("lets the user create a Codex chat session", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      sessionId: "codex-json-1",
      mode: "json",
      provider: "codex",
    });
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByRole } = renderDialog();

    fireEvent.click(getByRole("button", { name: /聊天模式/ }));
    selectAgentCli("Codex");
    fireEvent.click(getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/home/dev",
          mode: "json",
          provider: "codex",
          permissionMode: "auto",
        }),
        expect.any(Number),
      );
    });
  });

  it("keeps chat mode selected when switching to Kimi", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      sessionId: "kimi-json-1",
      mode: "json",
      provider: "kimi",
    });
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByRole } = renderDialog();

    fireEvent.click(getByRole("button", { name: /聊天模式/ }));
    selectAgentCli("Kimi Code");

    const chatMode = getByRole("button", { name: /聊天模式/ }) as HTMLButtonElement;
    expect(chatMode.disabled).toBe(false);
    expect(chatMode).toHaveAttribute("aria-pressed", "true");
    expect(getByRole("button", { name: /^终端模式/ })).toHaveAttribute("aria-pressed", "false");
    expect(getByRole("combobox", { name: "权限模式" })).toHaveTextContent("手工审批");

    fireEvent.click(getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/home/dev",
          mode: "json",
          provider: "kimi",
          permissionMode: "default",
        }),
        expect.any(Number),
      );
    });
  });

  it("submits a manually entered working directory without overriding the terminal theme", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      sessionId: "claude-pty-1",
      mode: "pty",
      provider: "claude",
    });
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByRole } = renderDialog();
    const cwdInput = getByRole("textbox", { name: "工作目录" });
    expect(cwdInput).toBeInstanceOf(HTMLInputElement);
    expect(cwdInput).toHaveAttribute("type", "text");
    expect(cwdInput).toHaveAttribute("data-path-control", "input");
    fireEvent.change(cwdInput, { target: { value: "/srv/projects/dev-anywhere" } });

    fireEvent.click(getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(
        {
          kind: "agent",
          cwd: "/srv/projects/dev-anywhere",
          name: undefined,
          mode: "pty",
          provider: "claude",
          permissionMode: "default",
        },
        expect.any(Number),
      );
    });
  });

  it("sends selected provider/mode permission labels as permissionMode", async () => {
    for (const [
      providerLabel,
      mode,
      provider,
      permissionLabel,
      permissionMode,
    ] of sessionCreatePermissionCases) {
      const caseLabel = `${providerLabel} ${mode} ${permissionLabel}`;
      createSession.mockResolvedValueOnce({
        type: "session_create_response",
        sessionId: `${provider}-${mode}-${permissionMode}`,
        mode,
        provider,
      });
      useFileStore.setState({
        tree: new Map(),
        cwd: "",
        homePath: "/home/dev",
        agentCli: availableAgentCli,
      });

      const { getByRole } = renderDialog();

      if (mode === "json") {
        fireEvent.click(getByRole("button", { name: /聊天模式/ }));
      }
      if (provider !== "claude") {
        selectAgentCli(provider === "codex" ? "Codex" : "Kimi Code");
      }
      fireEvent.click(getByRole("combobox", { name: "权限模式" }));
      fireEvent.click(getByRole("option", { name: permissionLabel }));
      fireEvent.click(getByRole("button", { name: "创建" }));

      if (permissionMode === "bypassPermissions") {
        expect(createSession, caseLabel).not.toHaveBeenCalled();
        getByRole("heading", { name: "跳过全部审批？" });
        fireEvent.click(getByRole("button", { name: "确认" }));
      }

      await waitFor(() => {
        expect(createSession, caseLabel).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: "/home/dev",
            mode,
            provider,
            permissionMode,
          }),
          expect.any(Number),
        );
      });
      cleanup();
      createSession.mockReset();
    }
  });

  it("requires a second destructive action before creating a bypass session", async () => {
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByRole, getByText } = renderDialog();

    fireEvent.click(getByRole("combobox", { name: "权限模式" }));
    fireEvent.click(getByRole("option", { name: "跳过全部审批" }));
    fireEvent.click(getByRole("button", { name: "创建" }));

    const confirmButton = getByRole("button", { name: "确认" });
    expect(createSession).not.toHaveBeenCalled();
    expect(confirmButton.getAttribute("data-variant")).toBe("destructive");
    expect(document.activeElement).not.toBe(confirmButton);
    getByText("Claude Code 将不再请求工具审批。");
    getByText(/Agent 可以直接执行命令/);

    fireEvent.click(getByRole("button", { name: "返回" }));

    expect(createSession).not.toHaveBeenCalled();
    getByRole("button", { name: "创建" });
    expect(getByRole("combobox", { name: "权限模式" })).toHaveTextContent("跳过全部审批");
  });

  it("unblocks the create button when session creation times out", async () => {
    createSession.mockRejectedValue(new Error("创建超时，请检查开发机连接后重试"));
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByRole } = renderDialog();
    const createButton = getByRole("button", { name: "创建" });

    fireEvent.click(createButton);
    expect((getByRole("button", { name: "创建中..." }) as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => {
      expect((getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(toastError).toHaveBeenCalledWith("创建超时，请检查开发机连接后重试");
  });

  it("does not create a missing working directory as a side effect of session creation", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      sessionId: "",
      errorCode: "PATH_NOT_FOUND",
      error: "工作目录不存在或不可访问: /home/dev/missing-project",
    });
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByLabelText, getByRole, getByText } = renderDialog();

    const cwdInput = getByLabelText("工作目录") as HTMLInputElement;
    await waitFor(() => {
      expect(cwdInput.value).toBe("/home/dev");
    });
    fireEvent.change(cwdInput, { target: { value: "/home/dev/missing-project" } });
    fireEvent.click(getByRole("button", { name: "创建" }));

    await waitFor(() => {
      getByText("工作目录不存在");
    });
    expect(toastError).toHaveBeenCalledWith("找不到这个工作目录");
    expect(createDirectory).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("creates a directory from the directory picker without creating a session", async () => {
    createDirectory.mockResolvedValue({
      success: true,
      path: "/home/dev/new-project",
    });
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByLabelText } = renderDialog();

    const cwdInput = getByLabelText("工作目录") as HTMLInputElement;
    await waitFor(() => {
      expect(cwdInput.value).toBe("/home/dev");
    });
    fireEvent.focusIn(cwdInput);
    const picker = await waitFor(() => {
      const current = document.querySelector<HTMLElement>('[data-slot="file-path-picker"]');
      expect(current).toBeTruthy();
      return current as HTMLElement;
    });
    fireEvent.click(within(picker).getByRole("button", { name: "新建目录" }));
    const directoryName = picker.querySelector<HTMLInputElement>(
      '[data-slot="file-path-picker-create-directory-name"]',
    );
    if (!directoryName) throw new Error("directory name input did not open");
    fireEvent.change(directoryName, {
      target: { value: "new-project" },
    });
    fireEvent.click(within(picker).getByRole("button", { name: "创建目录" }));

    await waitFor(() => {
      expect(createDirectory).toHaveBeenCalledWith("/home/dev/new-project");
    });
    await waitFor(() => {
      expect(cwdInput.value).toBe("/home/dev/new-project/");
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("目录已创建");
  });

  it("does not open the directory picker from non-input focus in the working directory field", async () => {
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByLabelText, getByText } = renderDialog();

    const cwdInput = getByLabelText("工作目录") as HTMLInputElement;
    await waitFor(() => {
      expect(cwdInput.value).toBe("/home/dev");
    });
    fireEvent.focusIn(getByText("工作目录"));

    expect(document.querySelector('[data-slot="file-path-picker"]')).toBeNull();
  });

  it("lets a phone user browse to an absolute working directory and create the session", async () => {
    testViewport = "mobile";
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      sessionId: "mobile-workspace",
      mode: "pty",
      provider: "claude",
    });
    useFileStore.setState({
      tree: new Map([
        ["/home/dev", [{ name: "projects", isDir: true }]],
        ["/home/dev/projects", []],
      ]),
      treeWithHidden: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { baseElement, getByRole, queryByRole } = renderDialog();
    const cwdButton = await waitFor(() => {
      const control = getByRole("button", { name: "工作目录" });
      expect(control).toHaveTextContent("/home/dev");
      return control;
    });
    expect(cwdButton).toHaveAttribute("data-path-control", "button");
    expect(queryByRole("textbox", { name: "工作目录" })).not.toBeInTheDocument();

    fireEvent.click(cwdButton);
    fireEvent.click(
      baseElement.querySelector('[data-slot="file-entry"][data-entry-name="projects"]')!,
    );
    expect(createSession).not.toHaveBeenCalled();
    fireEvent.click(baseElement.querySelector('[data-slot="select-current-directory"]')!);
    expect(cwdButton).toHaveTextContent("/home/dev/projects/");

    fireEvent.click(getByRole("button", { name: "创建" }));
    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/home/dev/projects/" }),
        expect.any(Number),
      );
    });
  });

  it("uses a button browser instead of a text field for CLI paths on phones", async () => {
    testViewport = "mobile";
    updateAgentCliPath.mockResolvedValueOnce({
      provider: "claude",
      agentCli: {
        ...availableAgentCli,
        claude: {
          available: true,
          command: "/usr/local/bin/claude-custom",
          suggestions: availableAgentCli.claude.suggestions,
        },
      },
    });
    useFileStore.setState({
      tree: new Map(),
      treeWithHidden: new Map([["/usr/local/bin", [{ name: "claude-custom", isDir: false }]]]),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByRole, queryByRole } = renderDialog();
    const pathButton = getByRole("button", { name: "CLI 路径" });
    expect(pathButton).toHaveAttribute("data-path-control", "button");
    expect(queryByRole("textbox", { name: "CLI 路径" })).not.toBeInTheDocument();
    expect(queryByRole("button", { name: "指定路径" })).not.toBeInTheDocument();

    expect(pathButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(pathButton);
    expect(pathButton).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(getByRole("button", { name: "claude-custom" }));
    expect(pathButton).toHaveTextContent("/usr/local/bin/claude-custom");
    fireEvent.click(getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateAgentCliPath).toHaveBeenCalledWith("claude", "/usr/local/bin/claude-custom");
    });
  });

  it("does not create with an unsaved CLI path and can discard the draft", async () => {
    useFileStore.setState({
      tree: new Map(),
      treeWithHidden: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByRole, queryByRole } = renderDialog();
    const pathInput = getByRole("textbox", { name: "CLI 路径" });
    const createButton = getByRole("button", { name: "创建" });

    expect(createButton).toBeEnabled();
    fireEvent.change(pathInput, { target: { value: "/opt/bin/claude" } });
    expect(createButton).toBeDisabled();

    const actions = document.querySelector<HTMLElement>('[data-slot="agent-cli-path-actions"]');
    if (!actions) throw new Error("Expected CLI path draft actions");
    fireEvent.click(within(actions).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(pathInput).toHaveValue("/usr/local/bin/claude"));
    await waitFor(() => expect(createButton).toBeEnabled());
    expect(queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("disables an unavailable Agent CLI before creating a session", async () => {
    requestProxyInfo.mockResolvedValueOnce({
      homePath: "/home/dev",
      agentCli: {
        claude: { available: false, error: "claude not found in PATH" },
        codex: { available: true, command: "/usr/local/bin/codex" },
      },
    });

    const { getByRole, getByText } = renderDialog();

    await waitFor(() => getByText("claude not found in PATH"));
    const providerSelect = getByRole("combobox", { name: "Agent CLI" }) as HTMLButtonElement;
    // Missing CLI providers remain selectable so the path editor can be opened; only create is
    // blocked until the selected provider becomes available.
    expect(providerSelect.disabled).toBe(false);
    expect(providerSelect).not.toHaveAttribute("aria-disabled");
    expect((getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps working with an older AgentCliStatus that does not contain Kimi", () => {
    useFileStore.setState({
      tree: new Map(),
      treeWithHidden: new Map([["/home/dev/.local/bin", [{ name: "claude", isDir: false }]]]),
      cwd: "",
      homePath: "/home/dev",
      agentCli: {
        claude: { available: true, command: "/usr/local/bin/claude" },
        codex: { available: true, command: "/usr/local/bin/codex" },
      },
    });

    const { getByRole } = renderDialog();

    selectAgentCli("Kimi Code");
    expect((getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled).toBe(true);

    const pathInput = getByRole("textbox", { name: "CLI 路径" });
    expect(pathInput).toBeInstanceOf(HTMLInputElement);
    expect(pathInput).toHaveAttribute("data-path-control", "input");
  });

  it("lets the user set a missing Agent CLI path from the dialog", async () => {
    requestProxyInfo.mockResolvedValueOnce({
      homePath: "/home/dev",
      agentCli: {
        claude: { available: false, error: "claude not found in PATH" },
        codex: { available: true, command: "/usr/local/bin/codex" },
      },
    });
    updateAgentCliPath.mockResolvedValueOnce({
      provider: "claude",
      agentCli: {
        claude: {
          available: true,
          command: "/home/dev/.local/bin/claude",
          suggestions: ["/home/dev/.local/bin/claude"],
        },
        codex: { available: true, command: "/usr/local/bin/codex" },
      },
    });

    const { getByLabelText, getByRole, getByText, queryByRole } = renderDialog();

    await waitFor(() => getByText("claude not found in PATH"));
    const pathInput = getByLabelText("CLI 路径");
    expect(pathInput).toBeInstanceOf(HTMLInputElement);
    expect(pathInput).toHaveAttribute("type", "text");
    expect(pathInput).toHaveAttribute("data-path-control", "input");
    expect(queryByRole("button", { name: "指定路径" })).not.toBeInTheDocument();
    fireEvent.change(pathInput, {
      target: { value: "/home/dev/.local/bin/claude" },
    });
    fireEvent.click(getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateAgentCliPath).toHaveBeenCalledWith("claude", "/home/dev/.local/bin/claude");
    });
    expect(useFileStore.getState().agentCli?.claude.command).toBe("/home/dev/.local/bin/claude");
    expect(useFileStore.getState().agentCli?.claude.suggestions).toContain(
      "/home/dev/.local/bin/claude",
    );
    expect(toastSuccess).toHaveBeenCalledWith("Claude Code 路径已保存");
  });

  it("saves an Agent CLI path selected from the remote browser", async () => {
    updateAgentCliPath.mockResolvedValueOnce({
      provider: "claude",
      agentCli: {
        ...availableAgentCli,
        claude: {
          available: true,
          command: "/usr/local/bin/claude",
          suggestions: availableAgentCli.claude.suggestions,
        },
      },
    });
    useFileStore.setState({
      tree: new Map(),
      treeWithHidden: new Map([["/usr/local/bin", [{ name: "claude", isDir: false }]]]),
      cwd: "",
      homePath: "/home/dev",
      agentCli: {
        ...availableAgentCli,
        claude: {
          ...availableAgentCli.claude,
          command: "/usr/local/bin/claude-old",
        },
      },
    });

    const { getByLabelText, getByRole } = renderDialog();

    await waitFor(() => {
      getByLabelText("CLI 路径");
    });
    fireEvent.focus(getByLabelText("CLI 路径"));
    fireEvent.click(getByRole("button", { name: "claude" }));
    fireEvent.click(getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateAgentCliPath).toHaveBeenCalledWith("claude", "/usr/local/bin/claude");
    });
  });

  it("persists a user supplied title through session_create and locks it like rename", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      sessionId: "new-sess-1",
      mode: "json",
      provider: "claude",
      name: "Release checklist",
      nameLocked: true,
    });
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByLabelText, getByRole } = renderDialog();

    fireEvent.change(getByLabelText("名称（可选）"), {
      target: { value: "  Release checklist  " },
    });
    fireEvent.click(getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Release checklist" }),
        expect.any(Number),
      );
    });
    expect(useSessionStore.getState().sessions).toContainEqual(
      expect.objectContaining({
        sessionId: "new-sess-1",
        name: "Release checklist",
        nameLocked: true,
      }),
    );
  });

  // 用户在 createSession 还没回应前关闭弹窗（按 Esc / 切到其他界面）。dialog 受控关闭后
  // submitSessionCreate 仍把 promise resolve 后的成功路径走完，最严重的副作用是 navigate
  // 强行把 user 带去 /chat/<sessionId>——已经放弃创建却被路由劫持。
  it("does not navigate to /chat/<id> when the dialog has been closed mid-flight", async () => {
    type CreateResolve = (value: unknown) => void;
    let resolveCreate: CreateResolve = () => {};
    createSession.mockReturnValue(
      new Promise<unknown>((resolve) => {
        resolveCreate = resolve as CreateResolve;
      }),
    );
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    function ControlledDialog({ open }: { open: boolean }) {
      return (
        <MemoryRouter>
          <TooltipProvider>
            <CreateSessionDialog open={open} onOpenChange={vi.fn()} />
          </TooltipProvider>
        </MemoryRouter>
      );
    }

    const { rerender, getByRole } = render(<ControlledDialog open />);
    fireEvent.click(getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    // 用户关掉 dialog（受控 prop 翻 false，等价于 Esc / 父级关闭）
    rerender(<ControlledDialog open={false} />);

    // 此时后端才回应创建成功
    resolveCreate({
      type: "session_create_response",
      sessionId: "new-sess-1",
      mode: "json",
      provider: "claude",
    });

    await waitFor(() => {
      expect(useSessionStore.getState().sessions).toContainEqual(
        expect.objectContaining({ sessionId: "new-sess-1" }),
      );
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });
});
