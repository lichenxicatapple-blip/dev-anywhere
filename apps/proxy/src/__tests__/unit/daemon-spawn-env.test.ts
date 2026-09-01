import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { prepareDaemonSpawnEnvironment } from "#src/common/daemon-spawn-env.js";
import type { LoginShellPathSpawn } from "#src/common/login-shell-path.js";

describe("daemon spawn environment", () => {
  it("keeps the caller environment for manual start and restart", async () => {
    const spawn = vi.fn<LoginShellPathSpawn>();
    const inherited = {
      PATH: "/caller/bin:/usr/bin",
      SHELL: "/fake/zsh",
      AGENT_CREDENTIAL: "preserved",
    };

    await expect(
      prepareDaemonSpawnEnvironment({
        env: inherited,
        autoUpdateInvocation: false,
        refreshOptions: { spawn },
      }),
    ).resolves.toEqual({
      env: inherited,
      pathSource: "caller",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refreshes only PATH for an auto-update restart", async () => {
    const inherited = {
      PATH: "/old/bin:/usr/bin",
      SHELL: "/fake/zsh",
      AGENT_CREDENTIAL: "preserved",
    };
    const freshPath = "/new/bin:/usr/local/bin:/usr/bin";
    const spawn = vi.fn<LoginShellPathSpawn>((_command, _args, options) => {
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      Object.assign(child, { stdout, kill: vi.fn(() => true) });
      queueMicrotask(() => {
        stdout.end(`\x1edev-anywhere-path\x1f${freshPath}\x1edev-anywhere-path-end\x1f`);
        child.emit("close", 0, null);
      });
      expect(options.env).toBe(inherited);
      return child;
    });

    const result = await prepareDaemonSpawnEnvironment({
      env: inherited,
      autoUpdateInvocation: true,
      refreshOptions: { spawn },
    });

    expect(result).toEqual({
      env: { ...inherited, PATH: freshPath },
      pathSource: "login-shell",
    });
    expect(result.env.AGENT_CREDENTIAL).toBe("preserved");
    expect(inherited.PATH).toBe("/old/bin:/usr/bin");
  });

  it("falls back to the inherited PATH without blocking restart", async () => {
    const inherited = { PATH: "/old/bin:/usr/bin", SHELL: "/missing/shell" };
    const spawn = vi.fn<LoginShellPathSpawn>(() => {
      throw new Error("private system detail");
    });

    await expect(
      prepareDaemonSpawnEnvironment({
        env: inherited,
        autoUpdateInvocation: true,
        refreshOptions: { spawn },
      }),
    ).resolves.toEqual({
      env: inherited,
      pathSource: "fallback",
      failureReason: "spawn-failed",
    });
  });
});
