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

import type { HistorySession } from "@dev-anywhere/shared";
import { useSessionStore } from "@/stores/session-store";
import { HistoryList } from "./history-list";

function renderHistoryList(historySessions: HistorySession[]) {
  useSessionStore.setState({
    sessions: [],
    sessionListLoaded: true,
    historySessions,
    ptyTitles: {},
    ptyStateBySessionId: {},
    agentStatusBySessionId: {},
  });
  return render(
    <MemoryRouter>
      <HistoryList now={Date.now()} />
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
      sessionId: "restored-session",
      mode: "json",
      provider: "claude",
    });
    navigateMock.mockClear();
    toastError.mockClear();
    requestSessionHistory.mockReset();
    requestSessionHistory.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
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

    expect(requestSessionHistory).toHaveBeenCalledTimes(1);
    expect(refreshButton.getAttribute("aria-busy")).toBe("true");
    expect(refreshButton).toBeDisabled();
    expect(refreshButton.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");

    resolveRefresh([]);

    await waitFor(() => {
      expect(refreshButton.getAttribute("aria-busy")).toBe("false");
    });
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
    expect(screen.getByRole("dialog", { name: "恢复会话" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "恢复聊天" })).toBeTruthy();
    expect(screen.queryByText("权限模式")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "恢复聊天" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        cwd: "/Users/dev/project",
        mode: "json",
        provider: "claude",
        resumeSessionId: "claude-history-json",
      });
    });
    expect(navigateMock).toHaveBeenCalledWith("/chat/restored-session?mode=json");
  });

  it("lets Codex JSON history restore as chat by default", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      sessionId: "codex-json-session",
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
    fireEvent.click(screen.getByRole("button", { name: "恢复聊天" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        cwd: "/Users/dev/project",
        mode: "json",
        provider: "codex",
        resumeSessionId: "codex-history-json",
      });
    });
    expect(navigateMock).toHaveBeenCalledWith("/chat/codex-json-session?mode=json");
  });

  it("shows terminal permission choices only after Terminal is selected and restores bypass mode", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      sessionId: "pty-bypass-session",
      mode: "pty",
      provider: "claude",
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
    expect(screen.queryByText("权限模式")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "终端" }));
    expect(screen.getByText("权限模式")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "跳过全部审批" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复终端" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        cwd: "/Users/dev/project",
        mode: "pty",
        provider: "claude",
        resumeSessionId: "claude-history-unknown",
        permissionMode: "bypassPermissions",
      });
    });
  });
});
