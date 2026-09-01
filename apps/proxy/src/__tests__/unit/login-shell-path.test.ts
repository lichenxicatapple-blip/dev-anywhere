import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshLoginShellPath, type LoginShellPathSpawn } from "#src/common/login-shell-path.js";

const FRAME_START = "\x1edev-anywhere-path\x1f";
const FRAME_END = "\x1edev-anywhere-path-end\x1f";

function frame(path: string): string {
  return `${FRAME_START}${path}${FRAME_END}`;
}

function fakeChild(): {
  child: ChildProcess;
  output: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as ChildProcess;
  const output = new PassThrough();
  const kill = vi.fn(() => true);
  Object.assign(child, {
    pid: 4321,
    stdout: output,
    kill,
  });
  return { child, output, kill };
}

function completingSpawn(
  stdout: string | Buffer,
  code = 0,
): {
  spawn: ReturnType<typeof vi.fn<LoginShellPathSpawn>>;
  kill: ReturnType<typeof vi.fn>;
} {
  const { child, output, kill } = fakeChild();
  const spawn = vi.fn<LoginShellPathSpawn>(() => {
    queueMicrotask(() => {
      output.end(stdout);
      child.emit("close", code, null);
    });
    return child;
  });
  return { spawn, kill };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("login-shell PATH refresh", () => {
  it("returns only a strictly framed absolute PATH from an interactive login shell", async () => {
    const freshPath = "/opt/new/bin:/usr/local/bin:/usr/bin:/bin";
    const { spawn } = completingSpawn(`startup banner\n${frame(freshPath)}trailing output\n`);
    const env = {
      HOME: "/home/test-user",
      PATH: "/usr/bin:/bin",
      SHELL: "/fake/zsh",
      SECRET_TOKEN: "do-not-return",
    };

    await expect(refreshLoginShellPath({ env, spawn })).resolves.toEqual({
      source: "login-shell",
      path: freshPath,
    });

    expect(spawn).toHaveBeenCalledOnce();
    const [command, args, options] = spawn.mock.calls[0] as [
      string,
      readonly string[],
      SpawnOptions,
    ];
    expect(command).toBe("/fake/zsh");
    expect(args.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
    expect(args[3]).toContain('"$PATH"');
    expect(args[3]).not.toContain("SECRET_TOKEN");
    expect(options).toMatchObject({
      cwd: "/home/test-user",
      detached: true,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  });

  it("times out quickly, kills the shell, and preserves the inherited PATH", async () => {
    vi.useFakeTimers();
    const { child, kill } = fakeChild();
    const spawn = vi.fn<LoginShellPathSpawn>(() => child);
    const killProcessGroup = vi.fn();
    const promise = refreshLoginShellPath({
      env: { PATH: "/fallback/bin", SHELL: "/fake/sh" },
      spawn,
      killProcessGroup,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(promise).resolves.toEqual({
      source: "fallback",
      path: "/fallback/bin",
      reason: "timed-out",
    });
    expect(killProcessGroup).toHaveBeenCalledWith(4321);
    expect(kill).not.toHaveBeenCalled();
  });

  it("caps captured shell output and does not expose it in the failure result", async () => {
    const { spawn, kill } = completingSpawn(Buffer.alloc(128, 0x78));
    const killProcessGroup = vi.fn();

    await expect(
      refreshLoginShellPath({
        env: { PATH: "/fallback/bin", SHELL: "/fake/sh" },
        spawn,
        killProcessGroup,
        maxOutputBytes: 32,
      }),
    ).resolves.toEqual({
      source: "fallback",
      path: "/fallback/bin",
      reason: "output-limit-exceeded",
    });
    expect(killProcessGroup).toHaveBeenCalledWith(4321);
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to killing the shell directly when process-group cleanup fails", async () => {
    vi.useFakeTimers();
    const { child, kill } = fakeChild();
    const promise = refreshLoginShellPath({
      env: { PATH: "/fallback/bin", SHELL: "/fake/sh" },
      spawn: vi.fn<LoginShellPathSpawn>(() => child),
      killProcessGroup: vi.fn(() => {
        throw new Error("process group already gone");
      }),
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(promise).resolves.toMatchObject({
      source: "fallback",
      reason: "timed-out",
    });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.each([
    ["an empty PATH", ""],
    ["a relative entry", "relative/bin:/usr/bin"],
    ["an empty entry", "/usr/bin::/bin"],
    ["a control character", "/usr/bin\n/bin"],
  ])("rejects %s and falls back", async (_label, path) => {
    const { spawn } = completingSpawn(frame(path));

    await expect(
      refreshLoginShellPath({
        env: { PATH: "/fallback/bin", SHELL: "/fake/sh" },
        spawn,
      }),
    ).resolves.toEqual({
      source: "fallback",
      path: "/fallback/bin",
      reason: "invalid-path",
    });
  });

  it("falls back with a stable reason when the shell cannot be spawned", async () => {
    const spawn = vi.fn<LoginShellPathSpawn>(() => {
      throw new Error("sensitive operating-system detail");
    });

    await expect(
      refreshLoginShellPath({
        env: { PATH: "/fallback/bin", SHELL: "/missing/shell" },
        spawn,
      }),
    ).resolves.toEqual({
      source: "fallback",
      path: "/fallback/bin",
      reason: "spawn-failed",
    });
  });

  it("handles an asynchronous spawn failure without exposing its error", async () => {
    const { child } = fakeChild();
    const promise = refreshLoginShellPath({
      env: { PATH: "/fallback/bin", SHELL: "/fake/sh" },
      spawn: vi.fn<LoginShellPathSpawn>(() => {
        queueMicrotask(() => child.emit("error", new Error("sensitive child error")));
        return child;
      }),
    });

    await expect(promise).resolves.toEqual({
      source: "fallback",
      path: "/fallback/bin",
      reason: "spawn-failed",
    });
  });

  it("falls back when the login shell exits unsuccessfully", async () => {
    const { spawn } = completingSpawn(frame("/new/bin:/usr/bin"), 9);

    await expect(
      refreshLoginShellPath({
        env: { PATH: "/fallback/bin", SHELL: "/fake/sh" },
        spawn,
      }),
    ).resolves.toEqual({
      source: "fallback",
      path: "/fallback/bin",
      reason: "shell-exited",
    });
  });

  it("handles a defensive missing-output-pipe branch", async () => {
    const child = new EventEmitter() as ChildProcess;
    const kill = vi.fn(() => true);
    Object.assign(child, { pid: 4321, stdout: null, kill });
    const killProcessGroup = vi.fn();

    await expect(
      refreshLoginShellPath({
        env: { PATH: "/fallback/bin", SHELL: "/fake/sh" },
        spawn: vi.fn<LoginShellPathSpawn>(() => child),
        killProcessGroup,
      }),
    ).resolves.toEqual({
      source: "fallback",
      path: "/fallback/bin",
      reason: "missing-output-pipe",
    });
    expect(killProcessGroup).toHaveBeenCalledWith(4321);
    expect(kill).not.toHaveBeenCalled();
  });

  it("rejects malformed framing without returning captured shell output", async () => {
    const { spawn } = completingSpawn("profile printed something but no PATH frame");

    await expect(
      refreshLoginShellPath({
        env: { PATH: "/fallback/bin", SHELL: "/fake/sh" },
        spawn,
      }),
    ).resolves.toEqual({
      source: "fallback",
      path: "/fallback/bin",
      reason: "invalid-output",
    });
  });

  it.each([
    ["duplicate frames", Buffer.from(`${frame("/one/bin")}${frame("/two/bin")}`)],
    [
      "invalid UTF-8",
      Buffer.concat([Buffer.from(FRAME_START), Buffer.from([0xff]), Buffer.from(FRAME_END)]),
    ],
  ])("rejects %s", async (_label, output) => {
    const { spawn } = completingSpawn(output);

    await expect(
      refreshLoginShellPath({
        env: { PATH: "/fallback/bin", SHELL: "/fake/sh" },
        spawn,
      }),
    ).resolves.toEqual({
      source: "fallback",
      path: "/fallback/bin",
      reason: "invalid-output",
    });
  });

  it("preserves an undefined fallback PATH", async () => {
    await expect(refreshLoginShellPath({ env: {} })).resolves.toEqual({
      source: "fallback",
      path: undefined,
      reason: "invalid-shell",
    });
  });

  it("does not spawn a POSIX shell on an unsupported platform", async () => {
    const spawn = vi.fn<LoginShellPathSpawn>();

    await expect(
      refreshLoginShellPath({
        env: { PATH: "C:\\Windows", SHELL: "/fake/sh" },
        platform: "win32",
        spawn,
      }),
    ).resolves.toEqual({
      source: "fallback",
      path: "C:\\Windows",
      reason: "unsupported-platform",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
