import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_PROVIDER,
  buildClaudeHookSettings,
  buildClaudeArgs,
  filterClaudeEnvVars,
  resolveClaudeJsonCommand,
  resolveClaudePtyCommand,
} from "#src/providers/claude.js";

describe("Claude provider", () => {
  it("declares Claude provider capabilities", () => {
    expect(CLAUDE_PROVIDER.id).toBe("claude");
    expect(CLAUDE_PROVIDER.displayName).toBe("Claude Code");
    expect(CLAUDE_PROVIDER.capabilities.supportsHooks).toBe(true);
    expect(CLAUDE_PROVIDER.capabilities.supportsSessionScopedConfig).toBe(true);
    expect(CLAUDE_PROVIDER.capabilities.supportsProjectScopedConfig).toBe(true);
  });

  it("builds stream-json args with safe defaults", () => {
    const args = buildClaudeArgs({});

    expect(args).toEqual([
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      "default",
      "--fork-session",
    ]);
  });

  it("builds json command for Claude stream-json sessions", () => {
    const env = {
      PATH: "/usr/bin",
      CLAUDE_BIN: "/opt/bin/claude",
      CLAUDECODE_TOKEN: "secret",
    } as NodeJS.ProcessEnv;

    const command = CLAUDE_PROVIDER.buildJsonCommand(
      {
        extraArgs: ["--model", "opus"],
        permissionMode: "default",
        resumeSessionId: "sess-1",
        includePartialMessages: true,
      },
      env,
    );

    expect(command.command).toBe("/opt/bin/claude");
    expect(command.args).toEqual([
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      "default",
      "--verbose",
      "--resume",
      "sess-1",
      "--fork-session",
      "--include-partial-messages",
      "--model",
      "opus",
    ]);
    expect(command.env.CLAUDECODE_TOKEN).toBeUndefined();
    expect(command.env.CLAUDE_BIN).toBe("/opt/bin/claude");
  });

  it("filters CLAUDECODE variables but keeps normal Claude settings", () => {
    const filtered = filterClaudeEnvVars({
      CLAUDECODE_SECRET: "secret",
      CLAUDE_BIN: "claude",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv);

    expect(filtered).toEqual({
      CLAUDE_BIN: "claude",
      PATH: "/usr/bin",
    });
  });

  it("resolves json command without requiring claude in PATH", () => {
    expect(resolveClaudeJsonCommand({})).toBe("claude");
    expect(resolveClaudeJsonCommand({ CLAUDE_BIN: "/custom/claude" })).toBe("/custom/claude");
  });

  it("uses CLAUDE_BIN for PTY command before probing PATH", () => {
    expect(resolveClaudePtyCommand({ CLAUDE_BIN: "/custom/claude" })).toBe("/custom/claude");
  });

  it("builds PTY command without mutating args or env", () => {
    const args = ["--continue"];
    const env = { CLAUDE_BIN: "/custom/claude", TERM: "xterm" } as NodeJS.ProcessEnv;

    const command = CLAUDE_PROVIDER.buildTerminalCommand({ args }, env);

    expect(command).toEqual({
      command: "/custom/claude",
      args,
      env,
    });
  });

  it("maps terminal permission mode to Claude CLI args", () => {
    const command = CLAUDE_PROVIDER.buildTerminalCommand(
      { args: ["--continue"], permissionMode: "default" },
      { CLAUDE_BIN: "/custom/claude" },
    );

    expect(command.args).toEqual(["--permission-mode", "default", "--continue"]);
  });

  it("injects session-scoped Claude hook settings and env", () => {
    const hook = {
      provider: "claude" as const,
      sessionId: "s1",
      hookUrl: "http://127.0.0.1:17654/hook",
      marker: "marker-1",
      token: "token-1",
    };

    const command = CLAUDE_PROVIDER.buildJsonCommand({ hook }, { PATH: "/usr/bin" });

    expect(command.env.DEV_ANYWHERE_SESSION_ID).toBe("s1");
    expect(command.env.DEV_ANYWHERE_HOOK_URL).toBe("http://127.0.0.1:17654/hook");
    expect(command.args).toContain("--settings");
    const settings = JSON.parse(command.args[command.args.indexOf("--settings") + 1]) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
    };
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      "DEV_ANYWHERE_HOOK_EVENT='SessionStart'",
    );
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(31_536_000);
    expect(settings.hooks.SessionStart[0].hooks[0].timeout).toBe(5);
  });

  it("omits PermissionRequest hooks for PTY sessions so native TUI approval remains visible", () => {
    const hook = {
      provider: "claude" as const,
      sessionId: "s1",
      hookUrl: "http://127.0.0.1:17654/hook",
      marker: "marker-1",
      token: "token-1",
    };

    const command = CLAUDE_PROVIDER.buildTerminalCommand(
      { args: ["--continue"], hook },
      { CLAUDE_BIN: "/custom/claude" },
    );
    const settings = JSON.parse(command.args[command.args.indexOf("--settings") + 1]) as {
      hooks: Record<string, unknown>;
    };

    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PermissionRequest).toBeUndefined();
  });

  it("builds Claude hook settings without global config paths", () => {
    const settings = buildClaudeHookSettings();

    expect(JSON.stringify(settings)).not.toContain(".claude");
    expect(JSON.stringify(settings)).not.toContain(".codex");
    expect(JSON.stringify(settings)).not.toContain("token-1");
  });

  it("omits fork-session when disabled", () => {
    expect(buildClaudeArgs({ forkSession: false })).not.toContain("--fork-session");
  });

  it("does not call PATH resolution when CLAUDE_BIN is present", () => {
    const execFileSync = vi.fn();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(resolveClaudePtyCommand({ CLAUDE_BIN: "/already/set" })).toBe("/already/set");
  });
});
