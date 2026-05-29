import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import {
  buildHostedPtyArgs,
  HostedPtyRegistry,
  normalizeHostedPtyEnv,
} from "#src/serve/hosted-pty-registry.js";

const ptySpawnMock = vi.hoisted(() =>
  vi.fn(() => ({
    pid: 2468,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
);

vi.mock("node-pty", () => ({
  spawn: ptySpawnMock,
}));

function withExecutable(name: string, test: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-hosted-pty-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    test(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createRegistry(provider: "claude" | "codex", commandPath: string) {
  return new HostedPtyRegistry({
    sessionManager: {
      getSession: vi.fn(() => ({
        id: "s1",
        mode: "pty",
        provider,
        state: SessionState.IDLE,
        cwd: "/tmp/project",
        pid: 2468,
      })),
      terminateSession: vi.fn(() => ({ success: true })),
    } as never,
    relayConnection: {
      sendRaw: vi.fn(),
      sendBinary: vi.fn(),
    } as never,
    getProviderEnv: () =>
      provider === "claude" ? { CLAUDE_BIN: commandPath } : { CODEX_BIN: commandPath },
    touchSessionActivity: vi.fn(() => true),
    applyPtyStateToSession: vi.fn(),
    onSessionClosed: vi.fn(),
  });
}

describe("Hosted PTY registry", () => {
  afterEach(() => {
    ptySpawnMock.mockClear();
  });

  it("builds provider-specific resume args", () => {
    expect(buildHostedPtyArgs("claude", "claude-session")).toEqual(["--resume", "claude-session"]);
    expect(buildHostedPtyArgs("codex", "codex-session")).toEqual(["resume", "codex-session"]);
    expect(buildHostedPtyArgs("claude")).toEqual([]);
  });

  it("normalizes hosted PTY env as a truecolor terminal", () => {
    const env = normalizeHostedPtyEnv({
      TERM: "dumb",
      NO_COLOR: "1",
      CLICOLOR: "0",
      COLORFGBG: "15;0",
      COLORTERM: "ignored",
      KEEP_ME: "yes",
      UNDEFINED_VALUE: undefined,
    });

    expect(env).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CLICOLOR: "1",
      KEEP_ME: "yes",
    });
    expect(env).not.toHaveProperty("NO_COLOR");
    expect(env).not.toHaveProperty("UNDEFINED_VALUE");
    expect(env).not.toHaveProperty("COLORFGBG");
  });

  it("sets COLORFGBG from the browser terminal theme instead of inheriting the host shell", () => {
    expect(normalizeHostedPtyEnv({ COLORFGBG: "15;0" }, "light").COLORFGBG).toBe("0;15");
    expect(normalizeHostedPtyEnv({ COLORFGBG: "0;15" }, "dark").COLORFGBG).toBe("15;0");
  });

  it("spawns Claude PTY with the requested permission mode", () => {
    withExecutable("claude", (claudeBin) => {
      const registry = createRegistry("claude", claudeBin);

      const pid = registry.start({
        sessionId: "s1",
        provider: "claude",
        cwd: "/tmp/project",
        args: ["--resume", "claude-session"],
        permissionMode: "plan",
        hook: {
          provider: "claude",
          sessionId: "s1",
          hookUrl: "http://127.0.0.1:1/hook",
          marker: "marker-1",
          token: "token-1",
        },
      });
      registry.destroyAll();

      expect(pid).toBe(2468);
      expect(ptySpawnMock).toHaveBeenCalledWith(
        claudeBin,
        expect.arrayContaining(["--permission-mode", "plan", "--resume", "claude-session"]),
        expect.objectContaining({ cwd: "/tmp/project" }),
      );
    });
  });

  it("spawns Codex PTY with the requested approval flags", () => {
    withExecutable("codex", (codexBin) => {
      const registry = createRegistry("codex", codexBin);

      const pid = registry.start({
        sessionId: "s1",
        provider: "codex",
        cwd: "/tmp/project",
        args: ["resume", "codex-session"],
        permissionMode: "bypassPermissions",
        terminalTheme: "light",
        hook: {
          provider: "codex",
          sessionId: "s1",
          hookUrl: "http://127.0.0.1:1/hook",
          marker: "marker-1",
          token: "token-1",
        },
      });
      registry.destroyAll();

      expect(pid).toBe(2468);
      expect(ptySpawnMock).toHaveBeenCalledWith(
        codexBin,
        [
          "-c",
          'theme="light"',
          "--dangerously-bypass-approvals-and-sandbox",
          "resume",
          "codex-session",
        ],
        expect.objectContaining({
          cwd: "/tmp/project",
          env: expect.objectContaining({ COLORFGBG: "0;15" }),
        }),
      );
    });
  });
});
