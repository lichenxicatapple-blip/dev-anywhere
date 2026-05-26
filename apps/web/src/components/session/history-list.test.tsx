import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createSession, navigateMock, toastError } = vi.hoisted(() => ({
  createSession: vi.fn(),
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

  it("directly restores a Dev Anywhere JSON history row using its preferred mode", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "恢复会话：恢复 JSON 会话" }));

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

  it("asks for an explicit mode when Claude history has no Dev Anywhere metadata", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "以气泡聊天恢复：未知 Claude 历史" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        cwd: "/Users/dev/project",
        mode: "json",
        provider: "claude",
        resumeSessionId: "claude-history-unknown",
      });
    });
  });
});
