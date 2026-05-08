import { describe, expect, it } from "vitest";
import { CODEX_PROVIDER, resolveCodexCommand } from "#src/providers/codex.js";

describe("Codex provider", () => {
  it("declares Codex provider capabilities", () => {
    expect(CODEX_PROVIDER.id).toBe("codex");
    expect(CODEX_PROVIDER.displayName).toBe("Codex CLI");
    expect(CODEX_PROVIDER.capabilities.supportsHooks).toBe(true);
    expect(CODEX_PROVIDER.capabilities.supportsSessionScopedConfig).toBe(true);
  });

  it("uses CODEX_BIN before probing PATH", () => {
    expect(resolveCodexCommand({ CODEX_BIN: "/custom/codex" })).toBe("/custom/codex");
  });

  it("builds PTY command without mutating args or env when hooks are absent", () => {
    const args = ["exec", "--json", "Say OK"];
    const env = { CODEX_BIN: "/custom/codex", TERM: "xterm" } as NodeJS.ProcessEnv;

    const command = CODEX_PROVIDER.buildTerminalCommand({ args }, env);

    expect(command).toEqual({
      command: "/custom/codex",
      args,
      env,
    });
  });

  it("does not inject session-scoped hooks into PTY sessions", () => {
    const hook = {
      provider: "codex" as const,
      sessionId: "s1",
      hookUrl: "http://127.0.0.1:17654/hook",
      marker: "marker-1",
      token: "token-1",
    };

    const command = CODEX_PROVIDER.buildTerminalCommand(
      { args: ["exec", "--json", "Say OK"], hook },
      { CODEX_BIN: "/custom/codex" },
    );

    expect(command.command).toBe("/custom/codex");
    expect(command.args).toEqual(["exec", "--json", "Say OK"]);
    expect(command.env).toEqual({ CODEX_BIN: "/custom/codex" });
    expect(command.args.join(" ")).not.toContain("features.hooks");
    expect(command.args.join(" ")).not.toContain("hooks=");
    expect(command.args.join(" ")).not.toContain("DEV_ANYWHERE_HOOK");
  });

  it("maps terminal permission modes to Codex approval flags", () => {
    const strict = CODEX_PROVIDER.buildTerminalCommand(
      { args: [], permissionMode: "default" },
      { CODEX_BIN: "/custom/codex" },
    );
    expect(strict.args).toEqual(["--ask-for-approval", "untrusted"]);

    const automatic = CODEX_PROVIDER.buildTerminalCommand(
      { args: [], permissionMode: "auto" },
      { CODEX_BIN: "/custom/codex" },
    );
    expect(automatic.args).toEqual(["--ask-for-approval", "on-request"]);

    const bypass = CODEX_PROVIDER.buildTerminalCommand(
      { args: [], permissionMode: "bypassPermissions" },
      { CODEX_BIN: "/custom/codex" },
    );
    expect(bypass.args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });

  it("keeps Codex approval flags before provider args", () => {
    const hook = {
      provider: "codex" as const,
      sessionId: "s1",
      hookUrl: "http://127.0.0.1:17654/hook",
      marker: "marker-1",
      token: "token-1",
    };

    const command = CODEX_PROVIDER.buildTerminalCommand(
      { args: ["resume", "codex-session"], permissionMode: "default", hook },
      { CODEX_BIN: "/custom/codex" },
    );

    expect(command.args).toEqual(["--ask-for-approval", "untrusted", "resume", "codex-session"]);
  });

  it("rejects JSON sessions until Codex stream parsing is implemented", () => {
    expect(() => CODEX_PROVIDER.buildJsonCommand({}, {})).toThrow(
      "Codex JSON sessions are not supported yet",
    );
  });
});
