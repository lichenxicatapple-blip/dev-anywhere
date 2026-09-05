import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createSession, requestSessionHistory, navigateMock, toastError } = vi.hoisted(() => ({
  createSession: vi.fn(),
  requestSessionHistory: vi.fn(),
  navigateMock: vi.fn(),
  toastError: vi.fn(),
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
    createSession,
    requestSessionHistory,
  },
}));

vi.mock("@/components/toast", () => ({
  toast: {
    error: toastError,
  },
}));

import { ControlErrorCode, type HistorySession } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { type HistoryLoadStatus, useSessionStore } from "@/stores/session-store";
import { HistoryList } from "./history-list";
import { CodexActiveWriterDialog } from "./codex-active-writer-dialog";

function renderHistoryList(
  historySessions: HistorySession[],
  historyLoadStatus: HistoryLoadStatus = "loaded",
) {
  useAppStore.setState({ selectedProxyId: "proxy-1" });
  useSessionStore.setState({
    sessions: [],
    sessionListLoaded: true,
    historySessions,
    historyLoadStatus,
    historyLoadGeneration: 0,
    ptyTitles: {},
    ptyStateBySessionId: {},
    agentStatusBySessionId: {},
    codexActiveWriterConflict: null,
  });
  return render(
    <MemoryRouter>
      <HistoryList now={Date.now()} />
      <CodexActiveWriterDialog />
    </MemoryRouter>,
  );
}

function expandHistory(container: HTMLElement) {
  const sectionHeader = container.querySelector<HTMLElement>(
    '[data-slot="history-section-header"]',
  );
  if (!sectionHeader) throw new Error("missing history section header");
  fireEvent.click(sectionHeader);
  fireEvent.click(screen.getByRole("button", { name: /project/ }));
}

describe("HistoryList", () => {
  beforeEach(() => {
    createSession.mockReset();
    createSession.mockResolvedValue({
      type: "session_create_response",
      success: true,
      sessionId: "restored-session",
      cwd: "/Users/dev/project",
      lastActive: 1,
      kind: "agent",
      mode: "json",
      provider: "claude",
    });
    navigateMock.mockClear();
    toastError.mockClear();
    requestSessionHistory.mockReset();
    requestSessionHistory.mockResolvedValue([]);
  });

  afterEach(async () => {
    cleanup();
    // Radix FocusScope restores focus in a zero-delay unmount callback. Let it
    // finish while this test file's jsdom realm is still active; otherwise a
    // parallel file can replace global CustomEvent before the callback runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("groups the same project directory with or without a trailing slash", () => {
    const { container } = renderHistoryList([
      {
        id: "without-slash",
        title: "无尾斜杠",
        projectDir: "/Users/dev/project",
        updatedAt: Date.now(),
        provider: "claude",
        preferredMode: "json",
      },
      {
        id: "with-slash",
        title: "有尾斜杠",
        projectDir: "/Users/dev/project/",
        updatedAt: Date.now() - 1,
        provider: "claude",
        preferredMode: "json",
      },
    ]);

    const sectionHeader = container.querySelector<HTMLElement>(
      '[data-slot="history-section-header"]',
    );
    if (!sectionHeader) throw new Error("missing history section header");
    fireEvent.click(sectionHeader);

    const groupHeaders = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="history-group-header"]'),
    );
    expect(groupHeaders).toHaveLength(1);
    expect(groupHeaders[0].querySelector("[title]")?.getAttribute("title")).toBe(
      "/Users/dev/project",
    );
    expect(groupHeaders[0].textContent).toContain("2");
  });

  it.each(["claude", "codex", "kimi"] as const)(
    "restores same-title %s histories using each row's native session ID",
    async (provider) => {
      const histories: HistorySession[] = ["native-first", "native-second"].map((id) => ({
        id,
        title: "Shared history title",
        projectDir: "/Users/dev/project",
        updatedAt: 1,
        provider,
        preferredMode: "json",
      }));
      for (const history of histories) {
        createSession.mockResolvedValueOnce({
          type: "session_create_response",
          success: true,
          sessionId: `restored-${history.id}`,
          cwd: history.projectDir,
          lastActive: 1,
          kind: "agent",
          mode: "json",
          provider,
        });
      }
      const { container } = renderHistoryList(histories);
      expandHistory(container);

      expect(container.querySelectorAll('[data-slot="history-group-header"]')).toHaveLength(1);
      const rowName = `恢复会话：${histories[0].title}`;
      expect(screen.getAllByRole("button", { name: rowName })).toHaveLength(2);

      for (const [index, history] of histories.entries()) {
        fireEvent.click(screen.getAllByRole("button", { name: rowName })[index]);
        fireEvent.click(screen.getByRole("button", { name: "恢复" }));

        await waitFor(() => {
          expect(navigateMock).toHaveBeenNthCalledWith(
            index + 1,
            `/chat/restored-${history.id}?mode=json`,
          );
        });
        expect(createSession).toHaveBeenNthCalledWith(
          index + 1,
          expect.objectContaining({
            kind: "agent",
            provider,
            cwd: history.projectDir,
            mode: "json",
            resumeSessionId: history.id,
          }),
        );
      }
      expect(createSession).toHaveBeenCalledTimes(2);
      expect(useSessionStore.getState().sessions.map((session) => session.sessionId)).toEqual(
        histories.map((history) => `restored-${history.id}`),
      );
    },
  );

  it("keeps same-title histories in their respective project directory groups", () => {
    const projectDirs = ["/Users/dev/project-a", "/Users/dev/project-b"];
    const { container } = renderHistoryList(
      [projectDirs[0], projectDirs[1], projectDirs[0]].map((projectDir, index) => ({
        id: `native-${index}`,
        title: "Shared history title",
        projectDir,
        updatedAt: 3 - index,
        provider: "codex",
      })),
    );
    const sectionHeader = container.querySelector<HTMLElement>(
      '[data-slot="history-section-header"]',
    );
    if (!sectionHeader) throw new Error("missing history section header");
    fireEvent.click(sectionHeader);

    const groupHeaders = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="history-group-header"]'),
    );
    expect(
      groupHeaders.map((header) => header.querySelector("[title]")?.getAttribute("title")),
    ).toEqual(projectDirs);

    fireEvent.click(groupHeaders[0]);
    expect(screen.getAllByRole("button", { name: "恢复会话：Shared history title" })).toHaveLength(
      2,
    );
    fireEvent.click(groupHeaders[0]);
    fireEvent.click(groupHeaders[1]);
    expect(screen.getAllByRole("button", { name: "恢复会话：Shared history title" })).toHaveLength(
      1,
    );
  });

  it("shows an honest initial loading placeholder and disables refresh", () => {
    const { container } = renderHistoryList([], "loading");

    expect(screen.getByRole("status").textContent).toContain("正在加载会话记录");
    expect(container.querySelector('[data-slot="history-empty"]')).toBeNull();
    const refreshButton = screen.getByRole("button", { name: "刷新全部会话" });
    expect(refreshButton).toBeDisabled();
    expect(refreshButton.getAttribute("aria-busy")).toBe("true");
  });

  it("does not present an unrequested history snapshot as a real empty result", () => {
    const { container } = renderHistoryList([], "idle");

    expect(container.querySelector('[data-slot="history-idle"]')?.textContent).toContain(
      "尚未加载",
    );
    expect(container.querySelector('[data-slot="history-empty"]')).toBeNull();
    expect(screen.getByRole("button", { name: "刷新全部会话" })).not.toBeDisabled();
  });

  it("shows the empty state only after a successful empty snapshot", () => {
    const { container } = renderHistoryList([], "loaded");

    expect(container.querySelector('[data-slot="history-empty"]')?.textContent).toContain(
      "暂无会话记录",
    );
    expect(container.querySelector('[data-slot="history-loading"]')).toBeNull();
    expect(container.querySelector('[data-slot="history-error"]')).toBeNull();
  });

  it("spins the refresh button while refreshing all sessions", async () => {
    let resolveRefresh: (sessions: HistorySession[]) => void = () => {};
    requestSessionHistory.mockReturnValueOnce(
      new Promise<HistorySession[]>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const { container } = renderHistoryList([
      {
        id: "history-1",
        title: "历史会话",
        projectDir: "/Users/dev/project",
        updatedAt: Date.now(),
        provider: "claude",
        preferredMode: "json",
      },
    ]);

    const refreshButton = container.querySelector<HTMLElement>('[data-slot="history-refresh"]');
    if (!refreshButton) throw new Error("missing history refresh button");
    fireEvent.click(refreshButton);
    fireEvent.click(refreshButton);

    expect(requestSessionHistory).toHaveBeenCalledTimes(1);
    expect(refreshButton.getAttribute("aria-busy")).toBe("true");
    expect(refreshButton).toBeDisabled();
    expect(refreshButton.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");

    resolveRefresh([]);

    await waitFor(() => {
      expect(refreshButton.getAttribute("aria-busy")).toBe("false");
    });
    expect(container.querySelector('[data-slot="history-empty"]')).not.toBeNull();
  });

  it("unlocks refresh and exposes a retry state after a request timeout", async () => {
    requestSessionHistory.mockRejectedValueOnce(new Error("请求超时"));
    const { container } = renderHistoryList([]);
    const refreshButton = screen.getByRole("button", { name: "刷新全部会话" });

    fireEvent.click(refreshButton);
    expect(refreshButton).toBeDisabled();

    await waitFor(() => {
      expect(container.querySelector('[data-slot="history-error"]')?.textContent).toContain(
        "请点击刷新重试",
      );
    });
    expect(refreshButton).not.toBeDisabled();
    expect(refreshButton.getAttribute("aria-busy")).toBe("false");
    expect(toastError).toHaveBeenCalledWith("请求超时");
  });

  it("keeps cached history visible when a background refresh fails", () => {
    const history = {
      id: "cached-history",
      title: "Cached history",
      projectDir: "/workspace",
      updatedAt: 1,
      provider: "claude" as const,
    };
    const { container } = renderHistoryList([history], "error");

    expect(container.querySelector('[data-slot="history-stale"]')?.textContent).toContain(
      "上次加载的结果",
    );
    expect(container.querySelector('[data-slot="history-section-header"]')?.textContent).toContain(
      "· 1",
    );
    expect(screen.getByRole("button", { name: "刷新全部会话" })).not.toBeDisabled();
  });

  it("opens a restore dialog for a preferred JSON history row and shows its mode tag", async () => {
    const { container } = renderHistoryList([
      {
        id: "claude-history-json",
        title: "恢复 JSON 会话",
        projectDir: "/Users/dev/project",
        updatedAt: Date.now(),
        provider: "claude",
        preferredMode: "json",
      },
    ]);
    expandHistory(container);

    expect(
      container.querySelector('[data-slot="history-mode-tag"]')?.getAttribute("aria-label"),
    ).toBe("聊天视图");
    fireEvent.click(screen.getByRole("button", { name: "恢复会话：恢复 JSON 会话" }));
    const dialog = screen.getByRole("dialog", { name: "恢复会话" });
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(screen.getByRole("button", { name: "恢复" })).toBeTruthy();
    expect(screen.getByText("权限模式")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "严格审批" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        kind: "agent",
        cwd: "/Users/dev/project",
        mode: "json",
        provider: "claude",
        resumeSessionId: "claude-history-json",
        permissionMode: "default",
      });
    });
    expect(navigateMock).toHaveBeenCalledWith("/chat/restored-session?mode=json");
  });

  it("restores Codex JSON history with its supported approval policy by default", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      success: true,
      sessionId: "codex-json-session",
      cwd: "/Users/dev/project",
      lastActive: 1,
      kind: "agent",
      mode: "json",
      provider: "codex",
    });
    const { container } = renderHistoryList([
      {
        id: "codex-history-json",
        title: "Codex JSON 会话",
        projectDir: "/Users/dev/project",
        updatedAt: Date.now(),
        provider: "codex",
        preferredMode: "json",
      },
    ]);
    expandHistory(container);

    fireEvent.click(screen.getByRole("button", { name: "恢复会话：Codex JSON 会话" }));
    expect(screen.getByRole("radio", { name: "聊天" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "终端" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "严格审批" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "自动判定" })).toBeNull();
    expect(screen.getByRole("radio", { name: "按需审批" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText("Codex 在需要时请求确认。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        kind: "agent",
        cwd: "/Users/dev/project",
        mode: "json",
        provider: "codex",
        resumeSessionId: "codex-history-json",
        permissionMode: "auto",
      });
    });
    expect(navigateMock).toHaveBeenCalledWith("/chat/codex-json-session?mode=json");
  });

  it("restores Kimi ACP history in chat mode with Kimi permission choices", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      success: true,
      sessionId: "kimi-json-session",
      cwd: "/Users/dev/project",
      lastActive: 1,
      kind: "agent",
      mode: "json",
      provider: "kimi",
    });
    const { container } = renderHistoryList([
      {
        id: "kimi-history-json",
        title: "Kimi ACP 会话",
        projectDir: "/Users/dev/project",
        updatedAt: Date.now(),
        provider: "kimi",
        preferredMode: "json",
      },
    ]);
    expandHistory(container);

    fireEvent.click(screen.getByRole("button", { name: "恢复会话：Kimi ACP 会话" }));
    expect(screen.getByRole("radio", { name: "聊天" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "手工审批" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: "自动审批" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "只读规划" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "全自动" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "只读规划" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        kind: "agent",
        cwd: "/Users/dev/project",
        mode: "json",
        provider: "kimi",
        resumeSessionId: "kimi-history-json",
        permissionMode: "plan",
      });
    });
    expect(navigateMock).toHaveBeenCalledWith("/chat/kimi-json-session?mode=json");
  });

  it("shows a blocking PID-aware explanation when an external Codex writer owns the session", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      success: false,
      errorCode: ControlErrorCode.SESSION_ALREADY_ACTIVE,
      error: "另一个 Codex 进程正在使用此会话",
      activeWriterPid: 46559,
    });
    const { container } = renderHistoryList([
      {
        id: "codex-active-writer",
        title: "被占用的 Codex 会话",
        projectDir: "/Users/dev/project",
        updatedAt: Date.now(),
        provider: "codex",
        preferredMode: "json",
      },
    ]);
    expandHistory(container);

    fireEvent.click(screen.getByRole("button", { name: "恢复会话：被占用的 Codex 会话" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    expect(await screen.findByRole("heading", { name: "该 Codex 会话仍在运行" })).toBeTruthy();
    expect(screen.getByText("46559")).toBeTruthy();
    expect(screen.getByText(/不会自动终止该进程/)).toBeTruthy();
    expect(toastError).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("enters an already managed DEV Anywhere Codex session without another prompt", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      success: true,
      sessionId: "managed-codex-session",
      cwd: "/Users/dev/project",
      lastActive: 1,
      kind: "agent",
      mode: "pty",
      provider: "codex",
      ptyOwner: "local-terminal",
    });
    const { container } = renderHistoryList([
      {
        id: "codex-managed-native-thread",
        title: "仍在 DEV Anywhere 运行的会话",
        projectDir: "/Users/dev/project",
        updatedAt: Date.now(),
        provider: "codex",
        preferredMode: "json",
      },
    ]);
    expandHistory(container);

    fireEvent.click(screen.getByRole("button", { name: "恢复会话：仍在 DEV Anywhere 运行的会话" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/chat/managed-codex-session?mode=pty");
    });
    expect(useSessionStore.getState().sessions).toContainEqual({
      sessionId: "managed-codex-session",
      kind: "agent",
      state: "idle",
      mode: "pty",
      provider: "codex",
      ptyOwner: "local-terminal",
      cwd: "/Users/dev/project",
      lastActive: 1,
    });
    expect(useSessionStore.getState().codexActiveWriterConflict).toBeNull();
    expect(screen.queryByRole("heading", { name: "该 Codex 会话仍在运行" })).toBeNull();
  });

  it("keeps permission choices visible when switching from Chat to Terminal", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      success: true,
      sessionId: "pty-bypass-session",
      cwd: "/Users/dev/project",
      lastActive: 1,
      kind: "agent",
      mode: "pty",
      provider: "claude",
      ptyOwner: "proxy-hosted",
    });
    const { container } = renderHistoryList([
      {
        id: "claude-history-unknown",
        title: "未知 Claude 历史",
        projectDir: "/Users/dev/project",
        updatedAt: Date.now(),
        provider: "claude",
      },
    ]);
    expandHistory(container);

    expect(screen.queryByRole("button", { name: "以气泡聊天恢复：未知 Claude 历史" })).toBeNull();
    expect(screen.queryByRole("button", { name: "以终端会话恢复：未知 Claude 历史" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "以跳过审批终端恢复：未知 Claude 历史" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "恢复会话：未知 Claude 历史" }));
    expect(screen.getByText("权限模式")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "终端" }));
    expect(screen.getByText("权限模式")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "跳过全部审批" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    expect(createSession).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "跳过全部审批？" })).toBeTruthy();
    expect(screen.getByText("Claude Code 将不再请求工具审批。")).toBeTruthy();
    const confirmButton = screen.getByRole("button", { name: "确认" });
    expect(confirmButton.getAttribute("data-variant")).toBe("destructive");
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        kind: "agent",
        cwd: "/Users/dev/project",
        mode: "pty",
        provider: "claude",
        resumeSessionId: "claude-history-unknown",
        permissionMode: "bypassPermissions",
      });
    });
  });

  it("requires confirmation when restoring Chat with Bypass", async () => {
    const { container } = renderHistoryList([
      {
        id: "claude-history-chat-bypass",
        title: "聊天跳过审批",
        projectDir: "/Users/dev/project",
        updatedAt: Date.now(),
        provider: "claude",
        preferredMode: "json",
      },
    ]);
    expandHistory(container);

    fireEvent.click(screen.getByRole("button", { name: "恢复会话：聊天跳过审批" }));
    fireEvent.click(screen.getByRole("radio", { name: "跳过全部审批" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    expect(createSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        kind: "agent",
        cwd: "/Users/dev/project",
        mode: "json",
        provider: "claude",
        resumeSessionId: "claude-history-chat-bypass",
        permissionMode: "bypassPermissions",
      });
    });
  });
});
