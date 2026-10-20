import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SessionExitInfo } from "@dev-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionExitPanel } from "./session-exit-panel";

const exit: SessionExitInfo = {
  sessionId: "codex-startup",
  endedAt: 100,
  kind: "agent",
  provider: "codex",
  reason: "process-exit",
  exitCode: 1,
  details:
    "Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery timed out (code -32603)",
};

describe("SessionExitPanel", () => {
  afterEach(cleanup);

  it("preserves collapsed upstream diagnostics and offers navigation after an abnormal exit", () => {
    const onBack = vi.fn();
    const { container } = render(<SessionExitPanel exit={exit} mode="pty" onBack={onBack} />);
    expect(screen.getByRole("alert").textContent).toContain("终端异常退出");
    expect(screen.getByText("开发机上的进程异常退出，当前会话已结束。")).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getByText("错误详情")).toBeTruthy();
    expect(screen.getByText(exit.details!)).toBeTruthy();
    expect(screen.getByText("退出码：1")).toBeTruthy();
    expect(container.textContent).not.toContain("代理");
    fireEvent.click(screen.getByRole("button", { name: "返回会话列表" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("uses the same presentation for different providers and errors", () => {
    const { rerender } = render(
      <SessionExitPanel exit={{ ...exit, provider: "kimi" }} mode="pty" onBack={() => {}} />,
    );
    expect(screen.getByRole("heading").textContent).toBe("终端异常退出");
    rerender(
      <SessionExitPanel
        exit={{ ...exit, details: "request timed out" }}
        mode="pty"
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole("heading").textContent).toBe("终端异常退出");
  });

  it("describes a successful exit without reporting an error", () => {
    render(<SessionExitPanel exit={{ ...exit, exitCode: 0 }} mode="pty" onBack={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("进程已正常退出。")).toBeTruthy();
    expect(screen.getByText("退出详情")).toBeTruthy();
  });

  it("describes explicit termination without presenting it as a failure", () => {
    render(
      <SessionExitPanel
        exit={{ ...exit, reason: "user-terminated" }}
        mode="pty"
        onBack={() => {}}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading").textContent).toBe("会话已结束");
    expect(screen.getByText("已手动结束此远程会话。")).toBeTruthy();
    expect(screen.queryByText(/进程.*退出/)).toBeNull();
  });

  it("does not claim an exit when only the process channel is known to be lost", () => {
    render(
      <SessionExitPanel
        exit={{ ...exit, reason: "connection-lost", exitCode: undefined, details: undefined }}
        mode="json"
        channelFailed
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole("heading").textContent).toBe("会话连接已中断");
    expect(screen.getByText(/暂时无法确认进程是否仍在运行/)).toBeTruthy();
  });

  it("admits a missing exit reason", () => {
    render(<SessionExitPanel mode="pty" onBack={() => {}} />);
    expect(screen.getByText("未收到具体退出原因。")).toBeTruthy();
    expect(screen.queryByText("错误详情")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves exit details without claiming the reason is missing when no code was received", () => {
    render(
      <SessionExitPanel
        exit={{ ...exit, exitCode: undefined, details: "Process exited (signal: SIGTERM)" }}
        mode="pty"
        onBack={() => {}}
      />,
    );
    expect(screen.getByText("进程已退出，可展开查看详情。")).toBeTruthy();
    expect(screen.queryByText("未收到具体退出原因。")).toBeNull();
    expect(screen.getByText("Process exited (signal: SIGTERM)")).toBeTruthy();
    expect(screen.queryByText(/退出码/)).toBeNull();
  });
});
