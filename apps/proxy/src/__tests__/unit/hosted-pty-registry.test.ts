import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBinaryFrame, SessionState } from "@dev-anywhere/shared";
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

function createRegistry(
  provider: "claude" | "codex" | "kimi",
  commandPath: string,
  updateTerminalCwd = vi.fn(() => true),
) {
  return createAgentRegistry(provider, commandPath, updateTerminalCwd).registry;
}

function createAgentRegistry(
  provider: "claude" | "codex" | "kimi",
  commandPath: string,
  updateTerminalCwd = vi.fn(() => true),
) {
  const relayConnection = {
    sendRaw: vi.fn(),
    sendBinary: vi.fn(),
  };
  const sessionManager = {
    getSession: vi.fn(() => ({
      id: "s1",
      kind: "agent",
      mode: "pty",
      provider,
      ptyOwner: "proxy-hosted",
      state: SessionState.IDLE,
      cwd: "/tmp/project",
      pid: 2468,
      createdAt: 1,
      updatedAt: 1,
    })),
    terminateSession: vi.fn(() => ({ success: true })),
  };
  const registry = new HostedPtyRegistry({
    sessionManager: sessionManager as never,
    relayConnection: relayConnection as never,
    getProviderEnv: () => {
      if (provider === "claude") return { CLAUDE_BIN: commandPath };
      if (provider === "codex") return { CODEX_BIN: commandPath };
      return { KIMI_BIN: commandPath };
    },
    touchSessionActivity: vi.fn(() => true),
    updateTerminalCwd,
    applyPtyStateToSession: vi.fn(),
  });
  return { registry, relayConnection, sessionManager };
}

function createShellRegistry(shellPath: string) {
  const relayConnection = {
    sendRaw: vi.fn(),
    sendBinary: vi.fn(),
  };
  const registry = new HostedPtyRegistry({
    sessionManager: {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        kind: "terminal",
        mode: "pty",
        provider: "claude",
        ptyOwner: "local-terminal",
        state: SessionState.IDLE,
        cwd: "/tmp",
        pid: 2468,
        createdAt: 1,
        updatedAt: 1,
      })),
      terminateSession: vi.fn(() => ({ success: true })),
    } as never,
    relayConnection: relayConnection as never,
    getProviderEnv: () => ({ SHELL: shellPath }),
    touchSessionActivity: vi.fn(() => true),
    updateTerminalCwd: vi.fn(() => true),
    applyPtyStateToSession: vi.fn(),
  });
  return { registry, relayConnection };
}

type HostedPtyStartOptions = Parameters<HostedPtyRegistry["start"]>[0];

function startHostedPty(registry: HostedPtyRegistry, options: HostedPtyStartOptions): number {
  return registry.start(options);
}

describe("Hosted PTY registry", () => {
  afterEach(() => {
    ptySpawnMock.mockClear();
  });

  it("builds provider-specific resume args", () => {
    expect(buildHostedPtyArgs("claude", "claude-session")).toEqual(["--resume", "claude-session"]);
    expect(buildHostedPtyArgs("codex", "codex-session")).toEqual(["resume", "codex-session"]);
    expect(buildHostedPtyArgs("kimi", "kimi-session")).toEqual(["--session", "kimi-session"]);
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

      const pid = startHostedPty(registry, {
        sessionId: "s1",
        kind: "agent",
        provider: "claude",
        cwd: "/tmp/project",
        args: ["--resume", "claude-session"],
        cols: 80,
        rows: 24,
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

  it("aborts an unpublished PTY without emitting session lifecycle events", () => {
    withExecutable("claude", (claudeBin) => {
      const registry = createRegistry("claude", claudeBin);

      startHostedPty(registry, {
        sessionId: "pending-pty",
        kind: "agent",
        provider: "claude",
        cwd: "/tmp/project",
        args: [],
        cols: 80,
        rows: 24,
        hook: {
          provider: "claude",
          sessionId: "pending-pty",
          hookUrl: "http://127.0.0.1:1/hook",
          marker: "marker-1",
          token: "token-1",
        },
      });

      expect(registry.abortStartup("pending-pty")).toBe(true);
      expect(ptySpawnMock.mock.results.at(-1)?.value.kill).toHaveBeenCalledTimes(1);
      expect(registry.has("pending-pty")).toBe(false);
    });
  });

  it("removes hosted session records while destroying daemon-owned PTYs", () => {
    withExecutable("claude", (claudeBin) => {
      const { registry, sessionManager } = createAgentRegistry("claude", claudeBin);
      startHostedPty(registry, {
        sessionId: "s1",
        kind: "agent",
        provider: "claude",
        cwd: "/tmp/project",
        args: [],
        cols: 80,
        rows: 24,
      });

      registry.destroyAll();

      expect(ptySpawnMock.mock.results.at(-1)?.value.kill).toHaveBeenCalledOnce();
      expect(sessionManager.terminateSession).toHaveBeenCalledWith("s1");
    });
  });

  it("spawns Codex PTY with the requested approval flags", () => {
    withExecutable("codex", (codexBin) => {
      const registry = createRegistry("codex", codexBin);

      const pid = startHostedPty(registry, {
        sessionId: "s1",
        kind: "agent",
        provider: "codex",
        cwd: "/tmp/project",
        args: ["resume", "codex-session"],
        cols: 80,
        rows: 24,
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

  it("spawns Kimi PTY without a hook and maps its permission mode", () => {
    withExecutable("kimi", (kimiBin) => {
      const registry = createRegistry("kimi", kimiBin);

      const pid = startHostedPty(registry, {
        sessionId: "s1",
        kind: "agent",
        provider: "kimi",
        cwd: "/tmp/project",
        args: ["--session", "kimi-session"],
        cols: 80,
        rows: 24,
        permissionMode: "auto",
      });
      registry.destroyAll();

      expect(pid).toBe(2468);
      expect(ptySpawnMock).toHaveBeenCalledWith(
        kimiBin,
        ["--yolo", "--session", "kimi-session"],
        expect.objectContaining({ cwd: "/tmp/project" }),
      );
    });
  });

  it("spawns a pure shell terminal without provider args", () => {
    withExecutable("zsh", (shellPath) => {
      const registry = createRegistry("claude", shellPath);

      const pid = startHostedPty(registry, {
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
        cols: 80,
        rows: 24,
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

  it("starts a hosted PTY with the requested initial geometry", () => {
    withExecutable("codex", (codexBin) => {
      const registry = createRegistry("codex", codexBin);

      startHostedPty(registry, {
        sessionId: "s1",
        kind: "agent",
        provider: "codex",
        cwd: "/tmp/project",
        args: [],
        cols: 125,
        rows: 34,
        hook: {
          provider: "codex",
          sessionId: "s1",
          hookUrl: "http://127.0.0.1:1/hook",
          marker: "marker-1",
          token: "token-1",
        },
      });
      registry.destroyAll();

      expect(ptySpawnMock).toHaveBeenCalledWith(
        codexBin,
        [],
        expect.objectContaining({ cols: 125, rows: 34 }),
      );
    });
  });

  it("pushes a structured conflict when Codex reports an active writer after navigation", () => {
    withExecutable("codex", (codexBin) => {
      const relayConnection = {
        sendRaw: vi.fn(),
        sendBinary: vi.fn(),
      };
      const registry = new HostedPtyRegistry({
        sessionManager: {
          getSession: vi.fn(() => ({
            id: "s1",
            kind: "agent",
            mode: "pty",
            provider: "codex",
            ptyOwner: "proxy-hosted",
            state: SessionState.IDLE,
            cwd: "/tmp/project",
            pid: 2468,
            createdAt: 1,
            updatedAt: 1,
          })),
          terminateSession: vi.fn(() => ({ success: true })),
        } as never,
        relayConnection: relayConnection as never,
        getProviderEnv: () => ({ CODEX_BIN: codexBin }),
        touchSessionActivity: vi.fn(() => true),
        updateTerminalCwd: vi.fn(() => true),
        applyPtyStateToSession: vi.fn(),
      });
      const nativeSessionId = "019fa141-cdaf-78a2-a6c1-9cca04fb9f9a";

      startHostedPty(registry, {
        sessionId: "s1",
        kind: "agent",
        provider: "codex",
        cwd: "/tmp/project",
        args: ["resume", nativeSessionId],
        cols: 80,
        rows: 24,
        permissionMode: "auto",
        nativeSessionId,
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
      const onExit = spawned.onExit.mock.calls[0][0] as (event: {
        exitCode: number;
        signal: number;
      }) => void;

      onData("ordinary terminal output".repeat(600));
      onData(`\r\nError: thread ${nativeSessionId} already has an active writer (code -32600)\r\n`);
      onExit({ exitCode: 1, signal: 0 });

      const messages = relayConnection.sendRaw.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "session_runtime_error",
          sessionId: "s1",
          errorCode: "SESSION_ALREADY_ACTIVE",
          error: expect.stringContaining("不会自动终止"),
        }),
      );
    });
  });

  it("waits for queued output before sending a hosted PTY snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-hosted-pty-snapshot-"));
    const shellPath = join(dir, "zsh");
    writeFileSync(shellPath, "#!/bin/sh\n");
    chmodSync(shellPath, 0o755);
    const relayConnection = {
      sendRaw: vi.fn(),
      sendBinary: vi.fn(),
    };
    const registry = new HostedPtyRegistry({
      sessionManager: {
        getSession: vi.fn(() => ({
          id: "terminal-1",
          kind: "terminal",
          mode: "pty",
          provider: "claude",
          ptyOwner: "local-terminal",
          state: SessionState.IDLE,
          cwd: "/tmp",
          pid: 2468,
          createdAt: 1,
          updatedAt: 1,
        })),
        terminateSession: vi.fn(() => ({ success: true })),
      } as never,
      relayConnection: relayConnection as never,
      getProviderEnv: () => ({ SHELL: shellPath }),
      touchSessionActivity: vi.fn(() => true),
      updateTerminalCwd: vi.fn(() => true),
      applyPtyStateToSession: vi.fn(),
    });

    try {
      startHostedPty(registry, {
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
        cols: 80,
        rows: 24,
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;

      onData("snapshot-sentinel\r\n");
      expect(registry.snapshot("terminal-1", "request-1")).toBe(true);
      expect(relayConnection.sendRaw).not.toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(relayConnection.sendRaw).toHaveBeenCalledTimes(1);
      });
      const snapshot = JSON.parse(relayConnection.sendRaw.mock.calls[0][0] as string) as {
        type: string;
        requestId: string;
        data: string;
        outputSeq: number;
      };
      expect(snapshot).toMatchObject({
        type: "session_snapshot",
        requestId: "request-1",
        outputSeq: 1,
      });
      expect(snapshot.data).toContain("snapshot-sentinel");
    } finally {
      registry.destroyAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a snapshot on its old watermark and geometry when resize follows immediately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-hosted-pty-resize-snapshot-"));
    const shellPath = join(dir, "zsh");
    writeFileSync(shellPath, "#!/bin/sh\n");
    chmodSync(shellPath, 0o755);
    const { registry, relayConnection } = createShellRegistry(shellPath);

    try {
      startHostedPty(registry, {
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
        cols: 80,
        rows: 24,
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;

      onData("before-resize\r\n");
      expect(registry.snapshot("terminal-1", "before-request")).toBe(true);
      expect(registry.resize("terminal-1", 100, 30)).toBe(true);
      onData("after-resize\r\n");

      await vi.waitFor(() => {
        const messages = relayConnection.sendRaw.mock.calls.map(([raw]) => JSON.parse(raw));
        expect(
          messages.some(
            (message) =>
              message.type === "session_snapshot" && message.requestId === "before-request",
          ),
        ).toBe(true);
      });
      const messages = relayConnection.sendRaw.mock.calls.map(
        ([raw]) => JSON.parse(raw) as Record<string, unknown>,
      );
      const resize = messages.find((message) => message.type === "terminal_resize");
      const beforeSnapshot = messages.find(
        (message) => message.type === "session_snapshot" && message.requestId === "before-request",
      );

      expect(resize).toMatchObject({ cols: 100, rows: 30, outputSeq: 2 });
      expect(beforeSnapshot).toMatchObject({ cols: 80, rows: 24, outputSeq: 1 });
      expect(beforeSnapshot?.data).toContain("before-resize");
      expect(beforeSnapshot?.data).not.toContain("after-resize");

      expect(registry.snapshot("terminal-1", "after-request")).toBe(true);
      await vi.waitFor(() => {
        const currentMessages = relayConnection.sendRaw.mock.calls.map(([raw]) => JSON.parse(raw));
        expect(
          currentMessages.some(
            (message) =>
              message.type === "session_snapshot" && message.requestId === "after-request",
          ),
        ).toBe(true);
      });
      const afterSnapshot = relayConnection.sendRaw.mock.calls
        .map(([raw]) => JSON.parse(raw) as Record<string, unknown>)
        .find(
          (message) => message.type === "session_snapshot" && message.requestId === "after-request",
        );
      expect(afterSnapshot).toMatchObject({ cols: 100, rows: 30, outputSeq: 3 });
      expect(afterSnapshot?.data).toContain("after-resize");
    } finally {
      registry.destroyAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sequences a hosted resize between the preceding and following PTY bytes", () => {
    withExecutable("zsh", (shellPath) => {
      const { registry, relayConnection } = createShellRegistry(shellPath);

      startHostedPty(registry, {
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
        cols: 80,
        rows: 24,
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;

      onData("before");
      expect(registry.resize("terminal-1", 100, 30)).toBe(true);
      onData("after");

      const binarySequences = relayConnection.sendBinary.mock.calls.map(([raw]) => {
        const decoded = decodeBinaryFrame(raw);
        if (!decoded) throw new Error("invalid PTY binary frame");
        return decoded.outputSeq;
      });
      const resize = relayConnection.sendRaw.mock.calls
        .map(([raw]) => JSON.parse(raw as string) as { type?: string; outputSeq?: number })
        .find((message) => message.type === "terminal_resize");

      expect(binarySequences).toEqual([1, 3]);
      expect(resize).toMatchObject({ type: "terminal_resize", outputSeq: 2 });
      expect(spawned.resize).toHaveBeenCalledWith(100, 30);
      registry.destroyAll();
    });
  });

  it("emits a synchronized-output transaction as one hosted render frame", () => {
    withExecutable("zsh", (shellPath) => {
      const { registry, relayConnection } = createShellRegistry(shellPath);

      startHostedPty(registry, {
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
        cols: 80,
        rows: 24,
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;
      const syncStart = "\x1b[?2026h";
      const syncEnd = "\x1b[?2026l";

      onData("before");
      onData(`${syncStart}first`);
      onData(`second${syncEnd}after`);

      const frames = relayConnection.sendBinary.mock.calls.map(([raw]) => {
        const decoded = decodeBinaryFrame(raw);
        if (!decoded) throw new Error("invalid PTY binary frame");
        return {
          outputSeq: decoded.outputSeq,
          data: Buffer.from(decoded.data).toString("utf8"),
        };
      });
      expect(frames).toEqual([
        { outputSeq: 1, data: "before" },
        { outputSeq: 2, data: `${syncStart}firstsecond${syncEnd}` },
        { outputSeq: 3, data: "after" },
      ]);

      registry.destroyAll();
      expect(relayConnection.sendBinary).toHaveBeenCalledTimes(3);
    });
  });

  it("coalesces a Kimi-sized synchronized redraw split across PTY chunks", () => {
    withExecutable("kimi", (kimiBin) => {
      const { registry, relayConnection } = createAgentRegistry("kimi", kimiBin);
      startHostedPty(registry, {
        sessionId: "s1",
        kind: "agent",
        provider: "kimi",
        cwd: "/tmp/project",
        args: [],
        cols: 80,
        rows: 24,
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;
      const syncStart = "\x1b[?2026h";
      const syncEnd = "\x1b[?2026l";
      const targetBytes = 350 * 1024;
      const body = "kimi-history-line\r\n"
        .repeat(Math.ceil(targetBytes / 19))
        .slice(0, targetBytes);
      const transaction = `${syncStart}\x1b[2J\x1b[H\x1b[3J${body}${syncEnd}`;

      for (let offset = 0; offset < transaction.length; offset += 1_013) {
        onData(transaction.slice(offset, offset + 1_013));
      }

      expect(relayConnection.sendBinary).toHaveBeenCalledTimes(1);
      const decoded = decodeBinaryFrame(relayConnection.sendBinary.mock.calls[0][0]);
      expect(decoded?.outputSeq).toBe(1);
      expect(Buffer.from(decoded?.data ?? []).toString("utf8")).toBe(transaction);

      registry.destroyAll();
      expect(relayConnection.sendBinary).toHaveBeenCalledTimes(1);
    });
  });

  it("flushes an incomplete synchronized-output transaction exactly once before resize", () => {
    withExecutable("zsh", (shellPath) => {
      const { registry, relayConnection } = createShellRegistry(shellPath);

      startHostedPty(registry, {
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
        cols: 80,
        rows: 24,
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;
      const incomplete = "\x1b[?2026hpartial";

      onData(incomplete);
      expect(relayConnection.sendBinary).not.toHaveBeenCalled();

      expect(registry.resize("terminal-1", 100, 30)).toBe(true);
      onData("after");

      const frames = relayConnection.sendBinary.mock.calls.map(([raw]) => {
        const decoded = decodeBinaryFrame(raw);
        if (!decoded) throw new Error("invalid PTY binary frame");
        return {
          outputSeq: decoded.outputSeq,
          data: Buffer.from(decoded.data).toString("utf8"),
        };
      });
      expect(frames).toEqual([
        { outputSeq: 1, data: incomplete },
        { outputSeq: 3, data: "after" },
      ]);
      expect(
        relayConnection.sendRaw.mock.calls
          .map(([raw]) => JSON.parse(raw as string) as { type?: string; outputSeq?: number })
          .find((message) => message.type === "terminal_resize"),
      ).toMatchObject({ outputSeq: 2 });

      registry.destroyAll();
      expect(relayConnection.sendBinary).toHaveBeenCalledTimes(2);
    });
  });

  it("flushes an incomplete synchronized-output transaction exactly once on close", () => {
    withExecutable("zsh", (shellPath) => {
      const { registry, relayConnection } = createShellRegistry(shellPath);

      startHostedPty(registry, {
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
        cols: 80,
        rows: 24,
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;
      const incomplete = "\x1b[?2026hpartial";

      onData(incomplete);
      expect(registry.terminate("terminal-1")).toBe(true);
      expect(registry.terminate("terminal-1")).toBe(false);

      expect(relayConnection.sendBinary).toHaveBeenCalledTimes(1);
      const decoded = decodeBinaryFrame(relayConnection.sendBinary.mock.calls[0][0]);
      expect(decoded?.outputSeq).toBe(1);
      expect(Buffer.from(decoded?.data ?? []).toString("utf8")).toBe(incomplete);
    });
  });

  it("reports a pure shell terminal working-directory change from OSC 7", () => {
    withExecutable("zsh", (shellPath) => {
      const updateTerminalCwd = vi.fn(() => true);
      const registry = createRegistry("claude", shellPath, updateTerminalCwd);

      startHostedPty(registry, {
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
        cols: 80,
        rows: 24,
      });
      const child = ptySpawnMock.mock.results.at(-1)?.value;
      const onData = child?.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;
      expect(onData).toBeTypeOf("function");

      onData?.("\x1b]7;file://host/Users/dev/My%20Project\x1b\\");

      expect(updateTerminalCwd).toHaveBeenCalledWith("terminal-1", "/Users/dev/My Project");
      registry.destroyAll();
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
            kind: "agent",
            mode: "pty",
            provider: "codex",
            ptyOwner: "proxy-hosted",
            state: SessionState.IDLE,
            cwd: "/tmp/project",
            pid: 2468,
            createdAt: 1,
            updatedAt: 1,
          })),
          terminateSession: vi.fn(() => ({ success: true })),
        } as never,
        relayConnection: relayConnection as never,
        getProviderEnv: () => ({ CODEX_BIN: codexBin }),
        touchSessionActivity: vi.fn(() => true),
        updateTerminalCwd: vi.fn(() => true),
        applyPtyStateToSession: vi.fn(),
      });

      startHostedPty(registry, {
        sessionId: "s1",
        kind: "agent",
        provider: "codex",
        cwd: "/tmp/project",
        args: [],
        cols: 80,
        rows: 24,
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

  it("keeps completion latched across PTY redraws and starts work on submitted input", () => {
    withExecutable("codex", (codexBin) => {
      const applyPtyStateToSession = vi.fn();
      const registry = new HostedPtyRegistry({
        sessionManager: {
          getSession: vi.fn(() => ({
            id: "s1",
            kind: "agent",
            mode: "pty",
            provider: "codex",
            ptyOwner: "proxy-hosted",
            state: SessionState.IDLE,
            cwd: "/tmp/project",
            pid: 2468,
            createdAt: 1,
            updatedAt: 1,
          })),
          terminateSession: vi.fn(() => ({ success: true })),
        } as never,
        relayConnection: {
          sendRaw: vi.fn(),
          sendBinary: vi.fn(),
        } as never,
        getProviderEnv: () => ({ CODEX_BIN: codexBin }),
        touchSessionActivity: vi.fn(() => true),
        updateTerminalCwd: vi.fn(() => true),
        applyPtyStateToSession,
      });

      startHostedPty(registry, {
        sessionId: "s1",
        kind: "agent",
        provider: "codex",
        cwd: "/tmp/project",
        args: [],
        cols: 80,
        rows: 24,
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
      expect(applyPtyStateToSession).not.toHaveBeenCalled();

      onData("agent response\r\n");
      expect(applyPtyStateToSession).not.toHaveBeenCalled();

      registry.write("s1", "next prompt");
      expect(applyPtyStateToSession).not.toHaveBeenCalled();

      registry.write("s1", "\r");
      registry.destroyAll();

      expect(applyPtyStateToSession.mock.calls).toEqual([["s1", "working"]]);
    });
  });

  it("keeps Codex approval state stable across action-required spinner frames", () => {
    withExecutable("codex", (codexBin) => {
      const applyPtyStateToSession = vi.fn();
      const registry = new HostedPtyRegistry({
        sessionManager: {
          getSession: vi.fn(() => ({
            id: "s1",
            kind: "agent",
            mode: "pty",
            provider: "codex",
            ptyOwner: "proxy-hosted",
            state: SessionState.WAITING_APPROVAL,
            cwd: "/tmp/project",
            pid: 2468,
            createdAt: 1,
            updatedAt: 1,
          })),
          terminateSession: vi.fn(() => ({ success: true })),
        } as never,
        relayConnection: {
          sendRaw: vi.fn(),
          sendBinary: vi.fn(),
        } as never,
        getProviderEnv: () => ({ CODEX_BIN: codexBin }),
        touchSessionActivity: vi.fn(() => true),
        updateTerminalCwd: vi.fn(() => true),
        applyPtyStateToSession,
      });

      startHostedPty(registry, {
        sessionId: "s1",
        kind: "agent",
        provider: "codex",
        cwd: "/tmp/project",
        args: [],
        cols: 80,
        rows: 24,
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

      onData("\x1b]0;[ ! ] Action Required | sample-app\x07");
      onData("\x1b]0;[ . ] Action Required | sample-app\x07");
      registry.destroyAll();

      expect(applyPtyStateToSession.mock.calls).toEqual([
        ["s1", "approval_wait"],
        ["s1", "approval_wait"],
      ]);
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
            ptyOwner: "local-terminal",
            state: SessionState.IDLE,
            cwd: "/tmp",
            pid: 2468,
            createdAt: 1,
            updatedAt: 1,
          })),
          terminateSession: vi.fn(() => ({ success: true })),
        } as never,
        relayConnection: {
          sendRaw: vi.fn(),
          sendBinary: vi.fn(),
        } as never,
        getProviderEnv: () => ({ SHELL: shellPath }),
        touchSessionActivity: vi.fn(() => true),
        updateTerminalCwd: vi.fn(() => true),
        applyPtyStateToSession,
      });

      startHostedPty(registry, {
        sessionId: "terminal-1",
        kind: "terminal",
        cwd: "/tmp",
        shell: shellPath,
        cols: 80,
        rows: 24,
      });
      const spawned = ptySpawnMock.mock.results.at(-1)!.value;
      const onData = spawned.onData.mock.calls[0][0] as (data: string) => void;

      onData("$ echo hi\r\n");
      registry.destroyAll();

      expect(applyPtyStateToSession).not.toHaveBeenCalledWith("terminal-1", "working");
    });
  });
});
