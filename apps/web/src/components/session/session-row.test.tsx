import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRow } from "./session-row";

describe("SessionRow", () => {
  afterEach(() => cleanup());

  it("shows user rename while keeping full cwd in the hover title", () => {
    render(
      <SessionRow
        session={{
          sessionId: "s1",
          mode: "pty",
          provider: "claude",
          state: "idle",
          name: "Release checklist",
          nameLocked: true,
          cwd: "/Users/dev/MyApps/dev-anywhere",
        }}
        selected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText("Release checklist").getAttribute("title")).toBe(
      "/Users/dev/MyApps/dev-anywhere",
    );
  });

  it("shows pure terminal cwd when it has not been renamed", () => {
    render(
      <SessionRow
        session={{
          sessionId: "term-1",
          kind: "terminal",
          mode: "pty",
          provider: "claude",
          state: "idle",
          name: "Terminal",
          cwd: "/Users/dev/MyApps/dev-anywhere",
          ptyOwner: "local-terminal",
        }}
        selected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText("~/MyApps/dev-anywhere").getAttribute("title")).toBe(
      "/Users/dev/MyApps/dev-anywhere",
    );
  });

  it("renders sidebar menu items as text-only and marks remote disconnect as destructive", async () => {
    render(
      <SessionRow
        session={{
          sessionId: "s1",
          mode: "pty",
          provider: "claude",
          state: "idle",
          name: "~/project",
          cwd: "/Users/dev/project",
          ptyOwner: "local-terminal",
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
