import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalWorkerSpawner } from "#src/serve/terminal-worker-spawner.js";

const fixture = vi.hoisted(() => ({
  child: { pid: 1234, stdin: { on: vi.fn(), end: vi.fn() }, kill: vi.fn() },
  spawn: vi.fn(),
}));
vi.mock("#src/common/env.js", () => ({ spawnScript: fixture.spawn }));
beforeEach(() => {
  fixture.spawn.mockReset().mockReturnValue(fixture.child);
  fixture.child.stdin.on.mockClear();
  fixture.child.stdin.end.mockClear();
  fixture.child.kill.mockClear();
});

describe("terminal worker spawner", () => {
  it("sends startup and hooks over the short-lived stdin channel, never argv", () => {
    const env = { PATH: "provider-path", PROVIDER_SETTING: "setting" };
    const hook = {
      provider: "claude",
      sessionId: "s1",
      marker: "marker",
      token: "secret",
      hookUrl: "http://127.0.0.1:1/hook",
    } as const;
    const started = new TerminalWorkerSpawner().start({
      sessionId: "s1",
      kind: "agent",
      provider: "claude",
      cwd: "/project",
      name: "--option-looking",
      cols: 80,
      rows: 24,
      args: ["--resume", "native"],
      hook,
      env,
    });
    const [, argv, options] = fixture.spawn.mock.calls[0];
    expect(argv).toEqual(
      expect.arrayContaining(["--session", "s1", "--kind", "agent", "--provider", "claude"]),
    );
    expect(argv.join(" ")).not.toContain("secret");
    expect(argv.join(" ")).not.toContain("native");
    expect(options).toMatchObject({ env, stdio: ["pipe", "ignore", "ignore"] });
    const bootstrap = JSON.parse(fixture.child.stdin.end.mock.calls[0][0]);
    expect(bootstrap).toMatchObject({
      hook,
      args: ["--resume", "native"],
      name: "--option-looking",
    });
    expect(bootstrap).not.toHaveProperty("env");
    expect(started.pid).toBe(1234);
    expect(fixture.child.kill).not.toHaveBeenCalled();
    started.abort();
    expect(fixture.child.kill).toHaveBeenCalledOnce();
  });

  it("returns an owned startup handle for pure shells too", () => {
    const started = new TerminalWorkerSpawner().start({
      sessionId: "shell-1",
      kind: "terminal",
      provider: "claude",
      cwd: "/project",
      name: "Shell",
      cols: 80,
      rows: 24,
    });
    expect(started.pid).toBe(1234);
    expect(JSON.parse(fixture.child.stdin.end.mock.calls[0][0])).toMatchObject({
      kind: "terminal",
      provider: "claude",
    });
  });

  it("fails and cleans up when spawn provides no bootstrap channel", () => {
    const child = { pid: 1234, stdin: null, kill: vi.fn() };
    fixture.spawn.mockReturnValue(child);
    expect(() =>
      new TerminalWorkerSpawner().start({
        sessionId: "s1",
        kind: "terminal",
        provider: "claude",
        cwd: "/project",
        name: "Shell",
        cols: 80,
        rows: 24,
      }),
    ).toThrow("bootstrap channel");
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
