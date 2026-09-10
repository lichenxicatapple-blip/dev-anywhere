import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_CREATE_CLIENT_TIMEOUT_MS } from "@dev-anywhere/shared";

const { createSession, requestProxyInfo } = vi.hoisted(() => ({
  createSession: vi.fn(),
  requestProxyInfo: vi.fn(),
}));
vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    createSession,
    requestProxyInfo,
    getPreviewScope: () => ({ proxyId: "windows", bindingId: "binding-1" }),
  },
}));
vi.mock("./create-session-dialog", () => ({ CreateSessionDialog: () => null }));
vi.mock("./history-list", () => ({ HistoryList: () => null }));
vi.mock("./session-row", () => ({ SessionRow: () => null }));
vi.mock("./session-rename-dialog", () => ({ SessionRenameDialog: () => null }));
vi.mock("./session-termination-dialog", () => ({ SessionTerminationDialog: () => null }));
vi.mock("@/components/preview/create-frontend-preview-dialog", () => ({
  CreateFrontendPreviewDialog: () => null,
}));
vi.mock("@/components/preview/preview-list", () => ({ PreviewList: () => null }));

import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CreateSessionButton, SessionList } from "./session-list";

function openCreateMenu(layout: "desktop" | "mobile") {
  const trigger = screen.getByRole("button", { name: "新建" });
  if (layout === "desktop") {
    fireEvent(
      trigger,
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, ctrlKey: false }),
    );
  } else {
    fireEvent.click(trigger);
  }
}

function renderCreate(layout: "desktop" | "mobile") {
  render(
    <MemoryRouter>
      <TooltipProvider>
        {layout === "desktop" ? <CreateSessionButton /> : <SessionList layout="page" />}
      </TooltipProvider>
    </MemoryRouter>,
  );
  openCreateMenu(layout);
}

describe("terminal shell creation choices", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({
      selectedProxyId: "windows",
      selectedProxyName: "Windows",
      connected: true,
      proxyOnline: true,
      proxyListLoaded: true,
      proxies: [
        {
          proxyId: "windows",
          name: "Windows",
          osName: "Windows",
          version: "0.9.6",
          online: true,
          sessions: [],
        },
        {
          proxyId: "linux",
          name: "Linux",
          osName: "Linux",
          version: "0.9.6",
          online: true,
          sessions: [],
        },
      ],
      terminalShellsLoaded: true,
      terminalShells: [
        { id: "powershell", label: "PowerShell 7" },
        { id: "cmd", label: "CMD" },
      ],
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    useSessionStore.setState({ sessionListLoaded: true });
    requestProxyInfo.mockReset();
    requestProxyInfo.mockResolvedValue({
      terminalShells: [
        { id: "powershell", label: "PowerShell 7" },
        { id: "cmd", label: "CMD" },
      ],
    });
    createSession.mockReset();
    createSession.mockResolvedValue({
      success: true,
      sessionId: "term-1",
      kind: "terminal",
      mode: "pty",
      cwd: "C:/Users/dev",
      lastActive: 1,
      provider: "claude",
      ptyOwner: "local-terminal",
      name: "PowerShell 7",
    });
  });
  afterEach(cleanup);

  it.each([
    ["desktop", "powershell", "PowerShell 7"],
    ["desktop", "cmd", "CMD"],
    ["mobile", "powershell", "PowerShell 7"],
    ["mobile", "cmd", "CMD"],
  ] as const)("creates %s %s from the second-level shell dialog", async (layout, shell, label) => {
    renderCreate(layout);
    const role = layout === "desktop" ? "menuitem" : "button";
    expect(await screen.findByRole(role, { name: "Shell 会话" })).toBeVisible();
    expect(screen.queryByText("PowerShell 7")).not.toBeInTheDocument();
    expect(screen.queryByText("CMD")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole(role, { name: "Shell 会话" }));

    expect(await screen.findByRole("dialog", { name: "Shell 会话" })).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole(role, { name: "Agent 会话" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PowerShell 7" })).toBeVisible();
    expect(screen.getByRole("button", { name: "CMD" })).toBeVisible();
    expect(createSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(
        { kind: "terminal", mode: "pty", shell },
        SESSION_CREATE_CLIENT_TIMEOUT_MS,
      );
      expect(screen.queryByRole("dialog", { name: "Shell 会话" })).not.toBeInTheDocument();
    });
  });

  it.each([
    ["desktop", "PowerShell 7", "CMD"],
    ["desktop", "CMD", "PowerShell 7"],
    ["mobile", "PowerShell 7", "CMD"],
    ["mobile", "CMD", "PowerShell 7"],
  ] as const)(
    "shows progress only on the selected %s %s option and restores both after failure",
    async (layout, selected, other) => {
      let resolveCreate!: (result: { success: false; error: string }) => void;
      createSession.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      );
      renderCreate(layout);
      const role = layout === "desktop" ? "menuitem" : "button";
      fireEvent.click(await screen.findByRole(role, { name: "Shell 会话" }));
      fireEvent.click(await screen.findByRole("button", { name: selected }));

      const pending = screen.getByRole("button", { name: "正在创建 Shell 会话..." });
      const otherOption = screen.getByRole("button", { name: other });
      expect(pending).toBeDisabled();
      expect(otherOption).toBeDisabled();
      expect(screen.queryByRole("button", { name: selected })).not.toBeInTheDocument();
      fireEvent.click(otherOption);
      expect(createSession).toHaveBeenCalledTimes(1);

      await act(async () => resolveCreate({ success: false, error: "创建失败" }));
      expect(screen.getByRole("button", { name: selected })).toBeEnabled();
      expect(screen.getByRole("button", { name: other })).toBeEnabled();
      expect(screen.queryByText("正在创建 Shell 会话...")).not.toBeInTheDocument();
    },
  );

  it.each(["desktop", "mobile"] as const)(
    "returns to session types and reopens the shell dialog on %s",
    async (layout) => {
      renderCreate(layout);
      const role = layout === "desktop" ? "menuitem" : "button";
      fireEvent.click(await screen.findByRole(role, { name: "Shell 会话" }));
      fireEvent.click(await screen.findByRole("button", { name: "返回" }));
      expect(await screen.findByRole(role, { name: "Agent 会话" })).toBeVisible();
      expect(screen.queryByRole("dialog", { name: "Shell 会话" })).not.toBeInTheDocument();
      expect(screen.queryByText("PowerShell 7")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole(role, { name: "Shell 会话" }));
      expect(await screen.findByRole("dialog", { name: "Shell 会话" })).toBeVisible();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(createSession).not.toHaveBeenCalled();
    },
  );

  it.each(["desktop", "mobile"] as const)(
    "starts at session types after the shell dialog is dismissed on %s",
    async (layout) => {
      renderCreate(layout);
      const role = layout === "desktop" ? "menuitem" : "button";
      fireEvent.click(await screen.findByRole(role, { name: "Shell 会话" }));
      fireEvent.click(await screen.findByRole("button", { name: "Close" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Shell 会话" })).not.toBeInTheDocument(),
      );
      openCreateMenu(layout);
      expect(await screen.findByRole(role, { name: "Shell 会话" })).toBeVisible();
      expect(screen.getByRole(role, { name: "Agent 会话" })).toBeVisible();
      expect(screen.queryByText("CMD")).not.toBeInTheDocument();
      expect(createSession).not.toHaveBeenCalled();
    },
  );

  it.each(["desktop", "mobile"] as const)(
    "keeps direct default shell creation for proxies without shell capabilities on %s",
    async (layout) => {
      useAppStore.getState().setTerminalShells(undefined);
      renderCreate(layout);
      const role = layout === "desktop" ? "menuitem" : "button";
      fireEvent.click(await screen.findByRole(role, { name: "Shell 会话" }));
      await waitFor(() => {
        expect(createSession).toHaveBeenCalledWith(
          { kind: "terminal", mode: "pty" },
          SESSION_CREATE_CLIENT_TIMEOUT_MS,
        );
      });
      expect(screen.queryByRole("dialog", { name: "Shell 会话" })).not.toBeInTheDocument();
    },
  );

  it.each(["desktop", "mobile"] as const)(
    "waits for Windows shell detection inside the second-level dialog on %s",
    async (layout) => {
      useAppStore.setState({ terminalShells: null, terminalShellsLoaded: false });
      let resolveInfo!: (info: {
        terminalShells: Array<{ id: "powershell"; label: string }>;
      }) => void;
      requestProxyInfo.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInfo = resolve;
          }),
      );
      renderCreate(layout);
      const role = layout === "desktop" ? "menuitem" : "button";
      expect(requestProxyInfo).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole(role, { name: "Shell 会话" }));
      const detecting = await screen.findByRole("button", { name: "正在检测终端..." });
      expect(detecting).toBeDisabled();
      fireEvent.click(detecting);
      expect(createSession).not.toHaveBeenCalled();

      await act(async () => {
        resolveInfo({ terminalShells: [{ id: "powershell", label: "PowerShell 7" }] });
      });
      fireEvent.click(await screen.findByRole("button", { name: "PowerShell 7" }));
      await waitFor(() =>
        expect(createSession).toHaveBeenCalledWith(
          { kind: "terminal", mode: "pty", shell: "powershell" },
          SESSION_CREATE_CLIENT_TIMEOUT_MS,
        ),
      );
    },
  );

  it.each(["desktop", "mobile"] as const)(
    "offers retry after Windows shell detection fails on %s",
    async (layout) => {
      useAppStore.setState({ terminalShells: null, terminalShellsLoaded: false });
      requestProxyInfo
        .mockRejectedValueOnce(new Error("读取开发机信息超时"))
        .mockResolvedValueOnce({ terminalShells: [{ id: "cmd", label: "CMD" }] });
      renderCreate(layout);
      const role = layout === "desktop" ? "menuitem" : "button";
      fireEvent.click(await screen.findByRole(role, { name: "Shell 会话" }));
      fireEvent.click(await screen.findByRole("button", { name: "终端检测失败，点击重试" }));
      expect(await screen.findByRole("button", { name: "CMD" })).toBeVisible();
      expect(requestProxyInfo).toHaveBeenCalledTimes(2);
      expect(createSession).not.toHaveBeenCalled();
    },
  );

  it.each(["desktop", "mobile"] as const)(
    "allows the default shell after an older Windows proxy answers without capabilities on %s",
    async (layout) => {
      useAppStore.setState({ terminalShells: null, terminalShellsLoaded: false });
      requestProxyInfo.mockResolvedValueOnce({});
      renderCreate(layout);
      const role = layout === "desktop" ? "menuitem" : "button";
      fireEvent.click(await screen.findByRole(role, { name: "Shell 会话" }));
      fireEvent.click(await screen.findByRole("button", { name: "启动 Shell" }));
      await waitFor(() =>
        expect(createSession).toHaveBeenCalledWith(
          { kind: "terminal", mode: "pty" },
          SESSION_CREATE_CLIENT_TIMEOUT_MS,
        ),
      );
      expect(useAppStore.getState().terminalShellsLoaded).toBe(true);
    },
  );

  it.each(["desktop", "mobile"] as const)(
    "removes Windows choices when the selected proxy changes while the shell dialog is open on %s",
    async (layout) => {
      renderCreate(layout);
      const role = layout === "desktop" ? "menuitem" : "button";
      fireEvent.click(await screen.findByRole(role, { name: "Shell 会话" }));
      expect(await screen.findByRole("button", { name: "CMD" })).toBeVisible();
      act(() => useAppStore.getState().setProxy("linux", "Linux"));
      expect(screen.queryByRole("button", { name: "CMD" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "启动 Shell" }));
      await waitFor(() =>
        expect(createSession).toHaveBeenCalledWith(
          { kind: "terminal", mode: "pty" },
          SESSION_CREATE_CLIENT_TIMEOUT_MS,
        ),
      );
    },
  );

  it.each(["desktop", "mobile"] as const)(
    "does not submit a stale shell choice after disconnecting on %s",
    async (layout) => {
      renderCreate(layout);
      const role = layout === "desktop" ? "menuitem" : "button";
      fireEvent.click(await screen.findByRole(role, { name: "Shell 会话" }));
      const cmd = await screen.findByRole("button", { name: "CMD" });
      act(() => useAppStore.setState({ connected: false, proxyOnline: false }));
      expect(cmd).toBeDisabled();
      fireEvent.click(cmd);
      expect(createSession).not.toHaveBeenCalled();
    },
  );

  it("ignores a shell detection response after the user returns to session types", async () => {
    useAppStore.setState({ terminalShells: null, terminalShellsLoaded: false });
    let resolveInfo!: (info: { terminalShells: Array<{ id: "cmd"; label: string }> }) => void;
    requestProxyInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInfo = resolve;
        }),
    );
    renderCreate("mobile");
    fireEvent.click(await screen.findByRole("button", { name: "Shell 会话" }));
    expect(await screen.findByRole("button", { name: "正在检测终端..." })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await act(async () => {
      resolveInfo({ terminalShells: [{ id: "cmd", label: "CMD" }] });
    });
    expect(useAppStore.getState().terminalShellsLoaded).toBe(false);
    expect(screen.getByRole("button", { name: "Agent 会话" })).toBeVisible();
    expect(screen.queryByText("CMD")).not.toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
  });
});
