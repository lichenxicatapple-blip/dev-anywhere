import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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
};

function renderDialog() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <CreateSessionDialog open onOpenChange={vi.fn()} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("CreateSessionDialog", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    sendControl.mockClear();
    onMessage.mockReset();
    onMessage.mockReturnValue(vi.fn());
    createSession.mockReset();
    createDirectory.mockReset();
    requestDirectoryList.mockReset();
    requestDirectoryList.mockResolvedValue({ path: "/home/dev", entries: [] });
    requestProxyInfo.mockReset();
    requestProxyInfo.mockResolvedValue({ homePath: "/home/dev", agentCli: availableAgentCli });
    updateAgentCliPath.mockReset();
    toastError.mockClear();
    toastSuccess.mockClear();
    navigateMock.mockClear();
    useFileStore.setState({
      tree: new Map(),
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

  it("describes chat mode as bubble-style and Voice Pilot capable", () => {
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByText } = renderDialog();

    getByText("气泡式对话，支持 Voice Pilot");
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

    const { getByLabelText, getByPlaceholderText } = renderDialog();

    const cwdInput = getByLabelText("工作目录") as HTMLInputElement;
    await waitFor(() => {
      expect(cwdInput.value).toBe("/home/dev");
    });
    fireEvent.focusIn(cwdInput);
    let picker: HTMLElement | null = null;
    await waitFor(() => {
      picker = document.querySelector<HTMLElement>('[data-slot="file-path-picker"]');
      expect(picker).toBeTruthy();
    });
    if (!picker) throw new Error("directory picker did not open");
    fireEvent.click(within(picker).getByRole("button", { name: "新建目录" }));
    fireEvent.change(getByPlaceholderText("目录名称"), {
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

  it("disables an unavailable Agent CLI before creating a session", async () => {
    requestProxyInfo.mockResolvedValueOnce({
      homePath: "/home/dev",
      agentCli: {
        claude: { available: false, error: "claude not found in PATH" },
        codex: { available: true, command: "/usr/local/bin/codex" },
      },
    });

    const { getByRole, getByText } = renderDialog();

    await waitFor(() => {
      getByText("未找到");
    });
    const claudeButton = getByRole("button", { name: "Claude Code" }) as HTMLButtonElement;
    expect(claudeButton.disabled).toBe(false);
    expect(claudeButton.getAttribute("aria-disabled")).toBe("true");
    expect((getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled).toBe(true);
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

    const { getByLabelText, getByRole, getByText } = renderDialog();

    await waitFor(() => {
      getByText("未找到");
    });
    fireEvent.click(getByRole("button", { name: "Claude Code" }));
    fireEvent.click(getByRole("button", { name: "指定路径" }));
    fireEvent.change(getByLabelText("CLI 路径"), {
      target: { value: "/home/dev/.local/bin/claude" },
    });
    fireEvent.click(getByRole("button", { name: "保存路径" }));

    await waitFor(() => {
      expect(updateAgentCliPath).toHaveBeenCalledWith("claude", "/home/dev/.local/bin/claude");
    });
    expect(useFileStore.getState().agentCli?.claude.command).toBe("/home/dev/.local/bin/claude");
    expect(useFileStore.getState().agentCli?.claude.suggestions).toContain(
      "/home/dev/.local/bin/claude",
    );
    expect(toastSuccess).toHaveBeenCalledWith("Claude Code 路径已保存");
  });

  it("lets the user choose from discovered Agent CLI path suggestions", async () => {
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: availableAgentCli,
    });

    const { getByLabelText, getByRole } = renderDialog();

    fireEvent.click(getByRole("button", { name: "指定路径" }));

    await waitFor(() => {
      getByLabelText("CLI 路径");
    });
    const options = Array.from(document.querySelectorAll("datalist option")).map((option) =>
      option.getAttribute("value"),
    );
    expect(options).toEqual(["/usr/local/bin/claude", "/home/dev/.local/bin/claude"]);
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

    // 给微任务跑完
    await new Promise((r) => setTimeout(r, 0));

    expect(navigateMock).not.toHaveBeenCalled();
  });
});
