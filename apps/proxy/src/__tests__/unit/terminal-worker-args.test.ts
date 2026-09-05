import { describe, expect, it } from "vitest";
import { buildTerminalWorkerArgs } from "#src/serve/terminal-worker-spawner.js";
import {
  parseTerminalWorkerBootstrap,
  parseTerminalWorkerCliArgs,
} from "#src/terminal-worker-args.js";

const identity = { sessionId: "session-1", kind: "agent", provider: "kimi" } as const;

describe("terminal worker args", () => {
  it("carries only the verifiable process identity in argv", () => {
    const argv = buildTerminalWorkerArgs(identity, "isolated");
    expect(argv).toEqual([
      "--profile",
      "isolated",
      "--session",
      "session-1",
      "--kind",
      "agent",
      "--provider",
      "kimi",
    ]);
    expect(parseTerminalWorkerCliArgs(argv)).toEqual(identity);
  });

  it("accepts explicit option values with equals syntax", () => {
    expect(
      parseTerminalWorkerCliArgs([
        "--profile=isolated",
        "--session=session-1",
        "--kind=terminal",
        "--provider=claude",
      ]),
    ).toEqual({ ...identity, kind: "terminal", provider: "claude" });
  });

  it.each([
    ["session-1", "/project", "name", "80", "24"],
    ["--session", "s1", "--kind", "agent"],
    ["--session", "s1", "--session", "s2", "--kind", "agent", "--provider", "kimi"],
    ["--session", "s1", "--kind", "terminal", "--provider", "kimi"],
    ["--session", "s1", "--kind", "agent", "--provider", "kimi", "--unknown", "value"],
  ])("rejects ambiguous or incomplete identity %j", (...argv) => {
    expect(parseTerminalWorkerCliArgs(argv)).toBeNull();
  });

  it("reads launch details from stdin independently of option-looking names and paths", () => {
    const bootstrap = {
      ...identity,
      sessionId: undefined,
      cwd: "C:\\My Project",
      name: "--profile",
      cols: 80,
      rows: 24,
      args: ["--session", "native-session"],
      permissionMode: "default",
    };
    expect(parseTerminalWorkerBootstrap(JSON.stringify(bootstrap), identity)).toEqual({
      kind: "agent",
      provider: "kimi",
      cwd: "C:\\My Project",
      name: "--profile",
      cols: 80,
      rows: 24,
      args: ["--session", "native-session"],
      permissionMode: "default",
    });
  });

  it("rejects bootstrap identity changes and out-of-range geometry", () => {
    const bootstrap = {
      kind: "agent",
      provider: "kimi",
      cwd: "/project",
      name: "name",
      cols: 80,
      rows: 24,
    };
    expect(() =>
      parseTerminalWorkerBootstrap(JSON.stringify({ ...bootstrap, provider: "codex" }), identity),
    ).toThrow("does not match");
    expect(() =>
      parseTerminalWorkerBootstrap(JSON.stringify({ ...bootstrap, cols: 0 }), identity),
    ).toThrow();
    expect(() =>
      parseTerminalWorkerBootstrap(
        JSON.stringify({
          ...bootstrap,
          hook: {
            provider: "claude",
            sessionId: "other",
            token: "secret",
            marker: "marker",
            hookUrl: "http://127.0.0.1/hook",
          },
        }),
        identity,
      ),
    ).toThrow("does not match");
  });
});
