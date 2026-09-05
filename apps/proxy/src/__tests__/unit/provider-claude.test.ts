import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { prepareCommandLaunch, spawnCommand } from "#src/common/command-launch.js";
import {
  CLAUDE_PROVIDER,
  buildClaudeHookSettings,
  buildClaudeArgs,
  filterClaudeEnvVars,
  resolveClaudeJsonCommand,
  resolveClaudePtyCommand,
} from "#src/providers/claude.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("#src/common/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/common/paths.js")>();
  return { ...actual, sessionPaths: (id: string) => actual.buildSessionPaths(fixture.root, id) };
});

beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), "dev-anywhere-claude-settings-"));
});
afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

function withExecutable(name: string, test: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-claude-provider-"));
  try {
    const windows = process.platform === "win32";
    const path = join(dir, windows ? `${name}.cmd` : name);
    writeFileSync(path, windows ? "@exit /b 0\r\n" : "#!/bin/sh\n");
    if (!windows) chmodSync(path, 0o755);
    test(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Claude provider", () => {
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
    withExecutable("claude", (claudeBin) => {
      expect(resolveClaudePtyCommand({ CLAUDE_BIN: claudeBin })).toBe(claudeBin);
    });
  });

  it("builds PTY command without mutating args or env", () => {
    const args = ["--continue"];
    withExecutable("claude", (claudeBin) => {
      const env = { CLAUDE_BIN: claudeBin, TERM: "xterm" } as NodeJS.ProcessEnv;

      const command = CLAUDE_PROVIDER.buildTerminalCommand({ args }, env);

      expect(command).toEqual({
        command: claudeBin,
        args,
        env,
      });
    });
  });

  it("maps terminal permission mode to Claude CLI args", () => {
    withExecutable("claude", (claudeBin) => {
      const command = CLAUDE_PROVIDER.buildTerminalCommand(
        { args: ["--continue"], permissionMode: "default" },
        { CLAUDE_BIN: claudeBin },
      );

      expect(command.args).toEqual(["--permission-mode", "default", "--continue"]);
    });
  });

  it("passes all supported Claude permission modes to stream-json and PTY commands", () => {
    const modes = ["default", "auto", "acceptEdits", "plan", "bypassPermissions"] as const;

    for (const permissionMode of modes) {
      const jsonCommand = CLAUDE_PROVIDER.buildJsonCommand(
        { permissionMode },
        { PATH: "/usr/bin" },
      );
      expect(jsonCommand.args).toEqual(
        expect.arrayContaining(["--permission-mode", permissionMode]),
      );

      withExecutable("claude", (claudeBin) => {
        const ptyCommand = CLAUDE_PROVIDER.buildTerminalCommand(
          { args: ["--continue"], permissionMode },
          { CLAUDE_BIN: claudeBin },
        );
        expect(ptyCommand.args).toEqual(["--permission-mode", permissionMode, "--continue"]);
      });
    }
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
    const settingsPath = command.args[command.args.indexOf("--settings") + 1];
    expect(settingsPath).toBe(join(fixture.root, "s1", "claude-json-settings.json"));
    if (process.platform !== "win32") expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<
        string,
        Array<{ hooks: Array<{ command: string; args: string[]; timeout?: number }> }>
      >;
    };
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(process.execPath);
    expect(settings.hooks.SessionStart[0].hooks[0].args[0]).toBe("-e");
    expect(settings.hooks.SessionStart[0].hooks[0].args[1]).toContain(
      'DEV_ANYWHERE_HOOK_EVENT = "SessionStart"',
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

    withExecutable("claude", (claudeBin) => {
      const command = CLAUDE_PROVIDER.buildTerminalCommand(
        { args: ["--continue"], hook },
        { CLAUDE_BIN: claudeBin },
      );
      const settingsPath = command.args[command.args.indexOf("--settings") + 1];
      expect(settingsPath).toBe(join(fixture.root, "s1", "claude-pty-settings.json"));
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string; args: string[] }> }>>;
      };

      // PreToolUse 必须真的有可执行 hook（不是空数组），否则 native TUI 审批前的拦截不会触发
      expect(Array.isArray(settings.hooks.PreToolUse)).toBe(true);
      expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(process.execPath);
      expect(settings.hooks.PreToolUse[0].hooks[0].args[1]).toContain(
        'DEV_ANYWHERE_HOOK_EVENT = "PreToolUse"',
      );
      expect(settings.hooks.PermissionRequest).toBeUndefined();
    });
  });

  it("builds Claude hook settings without global config paths", () => {
    const settings = buildClaudeHookSettings();

    expect(JSON.stringify(settings)).not.toContain(".claude");
    expect(JSON.stringify(settings)).not.toContain(".codex");
    expect(JSON.stringify(settings)).not.toContain("token-1");
  });

  it("keeps JSON and PTY settings separate and the complete CMD command below its limit", () => {
    const hook = {
      provider: "claude" as const,
      sessionId: "both",
      hookUrl: "http://127.0.0.1/hook",
      marker: "test",
      token: "test",
    };
    const json = CLAUDE_PROVIDER.buildJsonCommand({ hook }, {});
    withExecutable("claude", (command) => {
      const pty = CLAUDE_PROVIDER.buildTerminalCommand({ args: [], hook }, { CLAUDE_BIN: command });
      const jsonPath = json.args[json.args.indexOf("--settings") + 1];
      const ptyPath = pty.args[pty.args.indexOf("--settings") + 1];
      expect(jsonPath).not.toBe(ptyPath);
      expect(JSON.parse(readFileSync(jsonPath, "utf8")).hooks).toHaveProperty("PermissionRequest");
      expect(JSON.parse(readFileSync(ptyPath, "utf8")).hooks).not.toHaveProperty(
        "PermissionRequest",
      );
      for (const built of [json, pty]) {
        const launch = prepareCommandLaunch(
          "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
          built.args,
          {},
          "win32",
        );
        expect(launch.ptyArgs!.length).toBeLessThan(8191);
      }
    });
  });

  it.skipIf(process.platform !== "win32")(
    "starts a real batch shim with complete JSON and PTY hooks from a settings file",
    async () => {
      const script = join(fixture.root, "fake claude.cjs");
      const shim = join(fixture.root, "fake claude.cmd");
      writeFileSync(
        script,
        'const fs = require("node:fs"); const index = process.argv.indexOf("--settings"); process.stdout.write(fs.readFileSync(process.argv[index + 1], "utf8"));',
      );
      writeFileSync(
        shim,
        `@"${process.execPath.replace(/%/g, "%%")}" "${script.replace(/%/g, "%%")}" %*\r\n`,
      );
      const hook = {
        provider: "claude" as const,
        sessionId: "batch",
        hookUrl: "http://127.0.0.1/hook",
        marker: "test",
        token: "test",
      };
      const env = { ...process.env, CLAUDE_BIN: shim };
      const commands = [
        CLAUDE_PROVIDER.buildJsonCommand({ hook }, env),
        CLAUDE_PROVIDER.buildTerminalCommand({ args: [], hook }, env),
      ];
      for (const command of commands) {
        const child = spawnCommand(command.command, command.args, {
          env: command.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout!.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        try {
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          });
          expect(code).toBe(0);
          const settingsPath = command.args[command.args.indexOf("--settings") + 1];
          expect(JSON.parse(stdout)).toEqual(JSON.parse(readFileSync(settingsPath, "utf8")));
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }
      }
    },
  );

  it("executes the hook directly and forwards the selected event and response", async () => {
    let received: unknown;
    let authorization: string | undefined;
    const response = {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    };
    const server = createServer((request, result) => {
      let body = "";
      authorization = request.headers.authorization;
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        received = JSON.parse(body);
        result.setHeader("content-type", "application/json");
        result.end(JSON.stringify(response));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test hook address");
    const settings = buildClaudeHookSettings() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; args: string[] }> }>>;
    };
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    const child = spawnCommand(hook.command, hook.args, {
      env: {
        ...process.env,
        DEV_ANYWHERE_SESSION_ID: "hook-session",
        DEV_ANYWHERE_PROVIDER: "claude",
        DEV_ANYWHERE_HOOK_URL: `http://127.0.0.1:${address.port}/hook`,
        DEV_ANYWHERE_HOOK_TOKEN: "test-hook-token",
        DEV_ANYWHERE_HOOK_MARKER: "test-marker",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      let stdout = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      child.stdin!.end(
        JSON.stringify({ tool_name: "Read", tool_input: { file_path: "a & b.txt" } }),
      );
      expect(await exited).toBe(0);
      expect(JSON.parse(stdout)).toEqual(response);
      expect(authorization).toBe("Bearer test-hook-token");
      expect(received).toMatchObject({
        sessionId: "hook-session",
        event: "PreToolUse",
        payload: { tool_name: "Read" },
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("omits fork-session when disabled", () => {
    expect(buildClaudeArgs({ forkSession: false })).not.toContain("--fork-session");
  });

  it("uses CLAUDE_BIN directly without PATH resolution when set", () => {
    withExecutable("claude", (claudeBin) => {
      expect(resolveClaudePtyCommand({ CLAUDE_BIN: claudeBin })).toBe(claudeBin);
    });
  });
});
