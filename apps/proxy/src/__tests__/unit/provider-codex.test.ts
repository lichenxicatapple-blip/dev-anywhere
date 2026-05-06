import { describe, expect, it } from "vitest";
import {
  CODEX_HOOK_OUTPUT_EVENTS,
  CODEX_PROVIDER,
  getCodexHookForwarderScriptForTest,
  resolveCodexCommand,
} from "#src/providers/codex.js";

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

  it("injects session-scoped Codex hooks through process args and env", () => {
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
    expect(command.env.DEV_ANYWHERE_PROVIDER).toBe("codex");
    expect(command.env.DEV_ANYWHERE_SESSION_ID).toBe("s1");
    expect(command.env.DEV_ANYWHERE_HOOK_URL).toBe("http://127.0.0.1:17654/hook");
    expect(command.env.DEV_ANYWHERE_HOOK_FORWARDER).toContain(
      ".dev-anywhere/run/provider-hook-forwarder.mjs",
    );
    expect(command.args).toContain("features.codex_hooks=true");
    expect(command.args).toContain("exec");
    expect(command.args.join(" ")).toContain("hooks={PreToolUse=");
    expect(command.args.join(" ")).toContain("DEV_ANYWHERE_HOOK_EVENT=PreToolUse");
    expect(command.args.join(" ")).toContain("DEV_ANYWHERE_HOOK_FORWARDER");
    expect(command.args.join(" ")).toContain(
      'command="DEV_ANYWHERE_HOOK_EVENT=PreToolUse node \\"$DEV_ANYWHERE_HOOK_FORWARDER\\"", timeout=31536000',
    );
    expect(countInlineTableBraceBalance(command.args.join(" "))).toBe(0);
    expect(command.args.join(" ")).not.toContain(".codex/hooks.json");
    expect(command.args.join(" ")).not.toContain("token-1");
  });

  it("only writes provider hook output for Codex events that consume hook decisions", () => {
    expect(CODEX_HOOK_OUTPUT_EVENTS).toEqual(["PreToolUse", "PermissionRequest"]);
    expect(getCodexHookForwarderScriptForTest()).toContain("if (OUTPUT_EVENTS.has(request.event))");
  });

  it("rejects JSON sessions until Codex stream parsing is implemented", () => {
    expect(() => CODEX_PROVIDER.buildJsonCommand({}, {})).toThrow(
      "Codex JSON sessions are not supported yet",
    );
  });
});

function countInlineTableBraceBalance(value: string): number {
  let balance = 0;
  for (const char of value) {
    if (char === "{") balance++;
    if (char === "}") balance--;
  }
  return balance;
}
