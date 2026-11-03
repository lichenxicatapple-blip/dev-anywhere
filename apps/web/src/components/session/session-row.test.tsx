import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRow } from "./session-row";
import { useFileStore } from "@/stores/file-store";

describe("SessionRow", () => {
  beforeEach(() => useFileStore.setState({ homePath: "/Users/dev" }));
  afterEach(() => cleanup());

  it("shows user rename while keeping full cwd in the hover title", () => {
    render(
      <SessionRow
        session={{
          sessionId: "s1",
          kind: "agent",
          mode: "pty",
          provider: "claude",
          state: "idle",
          name: "Release checklist",
          nameLocked: true,
          cwd: "/Users/dev/MyApps/dev-anywhere",
          ptyOwner: "proxy-hosted",
          lastActive: 1,
        }}
        selected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText("Release checklist").getAttribute("title")).toBe(
      "/Users/dev/MyApps/dev-anywhere",
    );
  });

  it.each(["idle", "working", "compacting", "waiting_approval", "error", "terminated"] as const)(
    "keeps terminal details without an agent task status when state is %s",
    (state) => {
      const now = Date.UTC(2026, 10, 3);
      render(
        <SessionRow
          session={{
            sessionId: "term-1",
            kind: "terminal",
            mode: "pty",
            provider: "claude",
            state,
            name: "Terminal",
            cwd: "/Users/dev/MyApps/dev-anywhere",
            ptyOwner: "proxy-hosted",
            lastActive: now - 60_000,
          }}
          selected={false}
          now={now}
          onClick={vi.fn()}
        />,
      );

      expect(screen.getByText("~/MyApps/dev-anywhere").getAttribute("title")).toBe(
        "/Users/dev/MyApps/dev-anywhere",
      );
      expect(screen.queryByRole("status")).toBeNull();
      expect(
        screen.queryByText(/^(运行中|空闲|工作中|压缩中|等待审批|出错|已断开|已终止)$/),
      ).toBeNull();
      expect(screen.getByRole("img", { name: "终端视图" })).toBeTruthy();
      expect(screen.getByText("1 分钟前")).toBeTruthy();
      expect(screen.getAllByText("·")).toHaveLength(1);
    },
  );

  it.each([
    { state: "idle", label: "空闲", color: "success" },
    { state: "working", label: "工作中", color: "working" },
  ] as const)("preserves the agent $state status and color", ({ state, label, color }) => {
    render(
      <SessionRow
        session={{
          sessionId: "agent-1",
          kind: "agent",
          mode: "pty",
          provider: "codex",
          state,
          cwd: "/Users/dev/project",
          ptyOwner: "proxy-hosted",
          lastActive: 1,
        }}
        selected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByRole("status", { name: `会话状态：${label}` }).className).toContain(
      `bg-[var(--color-status-${color})]`,
    );
    expect(screen.getByText(label).className).toContain(`text-[var(--color-status-${color})]`);
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getAllByText("·")).toHaveLength(3);
  });

  it("renders sidebar menu items as text-only and marks remote disconnect as destructive", async () => {
    render(
      <SessionRow
        session={{
          sessionId: "s1",
          kind: "agent",
          mode: "pty",
          provider: "claude",
          state: "idle",
          name: "~/project",
          cwd: "/Users/dev/project",
          ptyOwner: "local-terminal",
          lastActive: 1,
        }}
        selected={false}
        onClick={vi.fn()}
        onRename={vi.fn()}
        onTerminate={vi.fn()}
      />,
    );

    const menuTrigger = screen.getByRole("button", { name: "会话操作" });
    menuTrigger.focus();
    fireEvent.keyDown(menuTrigger, { key: "Enter" });

    const renameItem = await screen.findByRole("menuitem", { name: "重命名" });
    const disconnectItem = screen.getByRole("menuitem", { name: "断开远程连接" });

    expect(renameItem.querySelector("svg")).toBeNull();
    expect(disconnectItem.querySelector("svg")).toBeNull();
    expect(disconnectItem.getAttribute("data-variant")).toBe("destructive");
  });
});
