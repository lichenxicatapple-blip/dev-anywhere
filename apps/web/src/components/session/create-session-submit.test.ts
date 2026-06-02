import { ControlErrorCode } from "@dev-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_PERMISSION_MODE_OPTIONS,
  extractMissingCwd,
  normalizePermissionModeForProvider,
  PERMISSION_MODE_OPTIONS,
  providerStatus,
  PROVIDER_LABEL,
  submitSessionCreate,
  submitTerminalCreate,
} from "./create-session-submit";

const agentCli = {
  claude: { available: true, command: "/usr/local/bin/claude" },
  codex: { available: true, command: "/usr/local/bin/codex" },
};

describe("create-session submit model", () => {
  it("keeps provider labels and permission options centralized for the dialog", () => {
    expect(PROVIDER_LABEL.claude).toBe("Claude Code");
    expect(PERMISSION_MODE_OPTIONS.map((option) => option.value)).toContain("acceptEdits");
    expect(CODEX_PERMISSION_MODE_OPTIONS.map((option) => option.value)).not.toContain(
      "acceptEdits",
    );
  });

  it("normalizes unsupported Codex permission modes back to default", () => {
    expect(normalizePermissionModeForProvider("codex", "acceptEdits")).toBe("default");
    expect(normalizePermissionModeForProvider("claude", "acceptEdits")).toBe("acceptEdits");
  });

  it("reports provider availability without requiring component render", () => {
    expect(providerStatus("claude", null)).toEqual({ label: "检测中", disabled: true });
    expect(
      providerStatus("claude", {
        claude: { available: false, error: "claude not found" },
        codex: { available: true, command: "/usr/local/bin/codex" },
      }),
    ).toEqual({ label: "未找到", disabled: true, title: "claude not found" });
  });

  it("extracts missing cwd only from the structured path error", () => {
    expect(
      extractMissingCwd(
        "工作目录不存在或不可访问: /home/dev/missing",
        ControlErrorCode.PATH_NOT_FOUND,
      ),
    ).toBe("/home/dev/missing");
    expect(extractMissingCwd("工作目录不存在或不可访问: /home/dev/missing")).toBeNull();
  });

  it("returns a validation result before touching relay when cwd is empty", async () => {
    const relay = { createSession: vi.fn() };

    await expect(
      submitSessionCreate({
        relay,
        agentCli,
        form: {
          cwd: " ",
          name: "",
          mode: "pty",
          provider: "claude",
          permissionMode: "default",
        },
      }),
    ).resolves.toEqual({ type: "validation_error", message: "请输入工作目录" });
    expect(relay.createSession).not.toHaveBeenCalled();
  });

  it("returns a relay-missing result before submit", async () => {
    await expect(
      submitSessionCreate({
        relay: null,
        agentCli,
        form: {
          cwd: "/home/dev",
          name: "",
          mode: "pty",
          provider: "claude",
          permissionMode: "default",
        },
      }),
    ).resolves.toEqual({ type: "relay_missing", message: "请先连接开发机" });
  });

  it("returns provider unavailable with the provider error", async () => {
    const relay = { createSession: vi.fn() };

    await expect(
      submitSessionCreate({
        relay,
        agentCli: {
          claude: { available: false, error: "claude not found" },
          codex: { available: true, command: "/usr/local/bin/codex" },
        },
        form: {
          cwd: "/home/dev",
          name: "",
          mode: "pty",
          provider: "claude",
          permissionMode: "default",
        },
      }),
    ).resolves.toEqual({
      type: "provider_unavailable",
      message: "Claude Code 不可用：claude not found",
    });
    expect(relay.createSession).not.toHaveBeenCalled();
  });

  it("returns missing cwd from a structured create response", async () => {
    const relay = {
      createSession: vi.fn().mockResolvedValue({
        type: "session_create_response",
        errorCode: ControlErrorCode.PATH_NOT_FOUND,
        error: "工作目录不存在或不可访问: /home/dev/missing-project",
      }),
    };

    await expect(
      submitSessionCreate({
        relay,
        agentCli,
        form: {
          cwd: "/home/dev/missing-project",
          name: "",
          mode: "pty",
          provider: "claude",
          permissionMode: "default",
        },
      }),
    ).resolves.toEqual({
      type: "missing_cwd",
      path: "/home/dev/missing-project",
      message: "找不到这个工作目录",
    });
  });

  it("builds the session store payload and route on successful create", async () => {
    const relay = {
      createSession: vi.fn().mockResolvedValue({
        type: "session_create_response",
        sessionId: "new-sess-1",
        mode: "json",
        provider: "codex",
        name: "Release checklist",
        nameLocked: true,
      }),
    };

    await expect(
      submitSessionCreate({
        relay,
        agentCli,
        form: {
          cwd: " /home/dev ",
          name: " Release checklist ",
          mode: "pty",
          provider: "claude",
          permissionMode: "default",
        },
      }),
    ).resolves.toEqual({
      type: "success",
      session: {
        sessionId: "new-sess-1",
        name: "Release checklist",
        nameLocked: true,
        state: "idle",
        mode: "json",
        provider: "codex",
      },
      route: "/chat/new-sess-1?mode=json",
    });
    expect(relay.createSession).toHaveBeenCalledWith(
      {
        kind: "agent",
        cwd: "/home/dev",
        name: "Release checklist",
        mode: "pty",
        provider: "claude",
        permissionMode: "default",
      },
      expect.any(Number),
    );
  });

  it("creates a pure terminal without cwd or provider availability", async () => {
    const relay = {
      createSession: vi.fn().mockResolvedValue({
        type: "session_create_response",
        sessionId: "term-1",
        kind: "terminal",
        mode: "pty",
        provider: "claude",
        ptyOwner: "proxy-hosted",
        name: "终端 · ~",
      }),
    };

    await expect(submitTerminalCreate({ relay })).resolves.toEqual({
      type: "success",
      session: {
        sessionId: "term-1",
        kind: "terminal",
        name: "终端 · ~",
        state: "idle",
        mode: "pty",
        provider: "claude",
        ptyOwner: "proxy-hosted",
      },
      route: "/chat/term-1?mode=pty",
    });
    expect(relay.createSession).toHaveBeenCalledWith(
      {
        kind: "terminal",
        mode: "pty",
      },
      expect.any(Number),
    );
  });
});
