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
      COLORFGBG: "15;0",
      KEEP_ME: "yes",
    });
    expect(env).not.toHaveProperty("NO_COLOR");
    expect(env).not.toHaveProperty("UNDEFINED_VALUE");
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
        ["--dangerously-bypass-approvals-and-sandbox", "resume", "codex-session"],
        expect.objectContaining({ cwd: "/tmp/project" }),
      );
    });
  });

  it("spawns a pure shell terminal without provider args", () => {
    withExecutable("zsh", (shellPath) => {
      const registry = createRegistry("claude", shellPath);

      const pid = registry.start({
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
      });
      registry.destroyAll();

      expect(pid).toBe(2468);
      expect(ptySpawnMock).toHaveBeenCalledWith(
        shellPath,
        [],
        expect.objectContaining({ cwd: "/tmp" }),
      );
    });
  });

  it("emits monotonic PTY semantic sequence numbers", () => {
    withExecutable("codex", (codexBin) => {
      const relayConnection = {
        sendRaw: vi.fn(),
        sendBinary: vi.fn(),
      };
      const registry = new HostedPtyRegistry({
        sessionManager: {
          getSession: vi.fn(() => ({
            id: "s1",
            mode: "pty",
            provider: "codex",
            state: SessionState.IDLE,
            cwd: "/tmp/project",
            pid: 2468,
          })),
          terminateSession: vi.fn(() => ({ success: true })),
        } as never,
        relayConnection: relayConnection as never,
        getProviderEnv: () => ({ CODEX_BIN: codexBin }),
        touchSessionActivity: vi.fn(() => true),
        applyPtyStateToSession: vi.fn(),
        onSessionClosed: vi.fn(),
      });

      registry.start({
        sessionId: "s1",
        provider: "codex",
        cwd: "/tmp/project",
        args: [],
        hook: {
          provider: "codex",
          sessionId: "s1",
          hookUrl: "http://127.0.0.1:1/hook",
          marker: "marker-1",
          token: "token-1",
        },
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;

      onData("\x1b]9;needs your permission: Bash\x07");
      onData("\x1b]9;needs your permission: Write\x07");
      registry.destroyAll();

      const states = relayConnection.sendRaw.mock.calls
        .map(([raw]) => JSON.parse(raw as string) as { type?: string; payload?: { seq?: number } })
        .filter((msg) => msg.type === "pty_state");

      expect(states[0]?.payload?.seq).toBe(1);
      expect(states[1]?.payload?.seq).toBe(2);
    });
  });

  it("promotes an idle session to working when PTY bytes arrive without a semantic state", () => {
    withExecutable("codex", (codexBin) => {
      const applyPtyStateToSession = vi.fn();
      const registry = new HostedPtyRegistry({
        sessionManager: {
          getSession: vi.fn(() => ({
            id: "s1",
            mode: "pty",
            provider: "codex",
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
        getProviderEnv: () => ({ CODEX_BIN: codexBin }),
        touchSessionActivity: vi.fn(() => true),
        applyPtyStateToSession,
        onSessionClosed: vi.fn(),
      });

      registry.start({
        sessionId: "s1",
        provider: "codex",
        cwd: "/tmp/project",
        args: [],
        hook: {
          provider: "codex",
          sessionId: "s1",
          hookUrl: "http://127.0.0.1:1/hook",
          marker: "marker-1",
          token: "token-1",
        },
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;

      onData("\x1b]0;⠧ dev-anywhere\x07");
      registry.destroyAll();

      expect(applyPtyStateToSession).toHaveBeenCalledWith("s1", "working");
    });
  });

  it("does not infer agent semantic state for pure terminal bytes", () => {
    withExecutable("zsh", (shellPath) => {
      const applyPtyStateToSession = vi.fn();
      const registry = new HostedPtyRegistry({
        sessionManager: {
          getSession: vi.fn(() => ({
            id: "terminal-1",
            kind: "terminal",
            mode: "pty",
            provider: "claude",
            state: SessionState.IDLE,
            cwd: "/tmp",
            pid: 2468,
          })),
          terminateSession: vi.fn(() => ({ success: true })),
        } as never,
        relayConnection: {
          sendRaw: vi.fn(),
          sendBinary: vi.fn(),
        } as never,
        getProviderEnv: () => ({ SHELL: shellPath }),
        touchSessionActivity: vi.fn(() => true),
        applyPtyStateToSession,
        onSessionClosed: vi.fn(),
      });

      registry.start({
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;

      onData("$ echo hi\r\n");
      registry.destroyAll();

      expect(applyPtyStateToSession).not.toHaveBeenCalledWith("terminal-1", "working");
    });
  });
});
