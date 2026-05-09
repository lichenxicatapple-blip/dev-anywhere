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
}));

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
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "",
      agentCli: null,
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
      expect(getByText("工作目录不存在")).toBeTruthy();
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
      expect(getByText("未找到")).toBeTruthy();
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
      expect(getByText("未找到")).toBeTruthy();
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
      expect(getByLabelText("CLI 路径")).toBeTruthy();
    });
    const options = Array.from(document.querySelectorAll("datalist option")).map((option) =>
      option.getAttribute("value"),
    );
    expect(options).toEqual(["/usr/local/bin/claude", "/home/dev/.local/bin/claude"]);
  });
});
