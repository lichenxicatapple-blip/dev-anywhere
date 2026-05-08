import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_PROVIDER, resolveCodexCommand } from "#src/providers/codex.js";

function withExecutable(name: string, test: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-codex-provider-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    test(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Codex provider", () => {
  it("declares Codex provider capabilities", () => {
    expect(CODEX_PROVIDER.id).toBe("codex");
    expect(CODEX_PROVIDER.displayName).toBe("Codex CLI");
    expect(CODEX_PROVIDER.capabilities.supportsHooks).toBe(true);
    expect(CODEX_PROVIDER.capabilities.supportsSessionScopedConfig).toBe(true);
  });

  it("uses CODEX_BIN before probing PATH", () => {
    withExecutable("codex", (codexBin) => {
      expect(resolveCodexCommand({ CODEX_BIN: codexBin })).toBe(codexBin);
    });
  });

  it("builds PTY command without mutating args or env when hooks are absent", () => {
    const args = ["exec", "--json", "Say OK"];
    withExecutable("codex", (codexBin) => {
      const env = { CODEX_BIN: codexBin, TERM: "xterm" } as NodeJS.ProcessEnv;

      const command = CODEX_PROVIDER.buildTerminalCommand({ args }, env);

      expect(command).toEqual({
        command: codexBin,
        args,
        env,
      });
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

    withExecutable("codex", (codexBin) => {
      const command = CODEX_PROVIDER.buildTerminalCommand(
        { args: ["exec", "--json", "Say OK"], hook },
        { CODEX_BIN: codexBin },
      );

      expect(command.command).toBe(codexBin);
      expect(command.args).toEqual(["exec", "--json", "Say OK"]);
      expect(command.env).toEqual({ CODEX_BIN: codexBin });
      expect(command.args.join(" ")).not.toContain("features.hooks");
      expect(command.args.join(" ")).not.toContain("hooks=");
      expect(command.args.join(" ")).not.toContain("DEV_ANYWHERE_HOOK");
    });
  });

  it("maps terminal permission modes to Codex approval flags", () => {
    withExecutable("codex", (codexBin) => {
      const strict = CODEX_PROVIDER.buildTerminalCommand(
        { args: [], permissionMode: "default" },
        { CODEX_BIN: codexBin },
      );
      expect(strict.args).toEqual(["--ask-for-approval", "untrusted"]);

      const automatic = CODEX_PROVIDER.buildTerminalCommand(
        { args: [], permissionMode: "auto" },
        { CODEX_BIN: codexBin },
      );
      expect(automatic.args).toEqual(["--ask-for-approval", "on-request"]);

      const bypass = CODEX_PROVIDER.buildTerminalCommand(
        { args: [], permissionMode: "bypassPermissions" },
        { CODEX_BIN: codexBin },
      );
      expect(bypass.args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    });
  });

  it("keeps Codex approval flags before provider args", () => {
    const hook = {
      provider: "codex" as const,
      sessionId: "s1",
      hookUrl: "http://127.0.0.1:17654/hook",
      marker: "marker-1",
      token: "token-1",
    };

    withExecutable("codex", (codexBin) => {
      const command = CODEX_PROVIDER.buildTerminalCommand(
        { args: ["resume", "codex-session"], permissionMode: "default", hook },
        { CODEX_BIN: codexBin },
      );

      expect(command.args).toEqual(["--ask-for-approval", "untrusted", "resume", "codex-session"]);
    });
  });

  it("rejects JSON sessions until Codex stream parsing is implemented", () => {
    expect(() => CODEX_PROVIDER.buildJsonCommand({}, {})).toThrow(
      "Codex JSON sessions are not supported yet",
    );
  });
});
