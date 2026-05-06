import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// 模拟 node-pty 的 IPty 接口
interface MockPty {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  pid: number;
}

let mockPty: MockPty;
let onDataCallback: ((data: string) => void) | null = null;
let onExitCallback: ((e: { exitCode: number; signal?: number }) => void) | null = null;

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    mockPty = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn((cb: (data: string) => void) => {
        onDataCallback = cb;
        return { dispose: vi.fn() };
      }),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
        onExitCallback = cb;
        return { dispose: vi.fn() };
      }),
      pid: 12345,
    };
    return mockPty;
  }),
}));

function createMockStdin(isTTY = true) {
  const emitter = new EventEmitter();
  const setRawMode = vi.fn().mockReturnThis();
  const resume = vi.fn();
  return Object.assign(emitter, {
    isTTY,
    setRawMode,
    resume,
  }) as unknown as NodeJS.ReadStream;
}

function createMockStdout(cols = 120, rows = 40) {
  const emitter = new EventEmitter();
  const write = vi.fn();
  return Object.assign(emitter, {
    columns: cols,
    rows,
    write,
  }) as unknown as NodeJS.WriteStream;
}

describe("PtyManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onDataCallback = null;
    onExitCallback = null;
  });

  async function createManager(
    overrides: {
      providerArgs?: string[];
      tap?: (data: string) => void;
      isTTY?: boolean;
      cols?: number;
      rows?: number;
      onSessionExit?: (code: number) => void;
    } = {},
  ) {
    const { PtyManager } = await import("#src/terminal/pty-manager.js");
    const pty = await import("node-pty");

    const stdin = createMockStdin(overrides.isTTY ?? true);
    const stdout = createMockStdout(overrides.cols ?? 120, overrides.rows ?? 40);
    const tap = overrides.tap ?? vi.fn();
    const provider = {
      id: "claude" as const,
      displayName: "Claude Code",
      capabilities: {
        supportsHooks: true,
        supportsSessionScopedConfig: true,
        supportsProjectScopedConfig: true,
        supportsGlobalSetup: true,
      },
      buildJsonCommand: vi.fn(),
      buildTerminalCommand: vi.fn(({ args }) => ({
        command: "claude",
        args,
        env: process.env,
      })),
    };

    const manager = new PtyManager({
      provider,
      providerArgs: overrides.providerArgs ?? [],
      tap,
      stdin,
      stdout,
      onSessionExit: overrides.onSessionExit,
    });

    return { manager, stdin, stdout, tap, pty, provider };
  }

  it("spawns claude with correct args and terminal dimensions", async () => {
    const { manager, pty } = await createManager({
      providerArgs: ["--help"],
      cols: 120,
      rows: 40,
    });

    manager.start();

    expect(pty.spawn).toHaveBeenCalledWith(
      expect.stringContaining("claude"),
      ["--help"],
      expect.objectContaining({ cols: 120, rows: 40 }),
    );
  });

  it("forwards stdin data to pty write", async () => {
    const { manager, stdin } = await createManager();

    manager.start();
    stdin.emit("data", Buffer.from("hello"));

    expect(mockPty.write).toHaveBeenCalledWith("hello");
  });

  it("forwards pty output to stdout and tap", async () => {
    const tap = vi.fn();
    const { manager, stdout } = await createManager({ tap });

    manager.start();
    expect(onDataCallback).not.toBeNull();
    onDataCallback!("test output");

    expect(stdout.write).toHaveBeenCalledWith("test output");
    expect(tap).toHaveBeenCalledWith("test output");
  });

  it("debounces resize events", async () => {
    vi.useFakeTimers();

    const { manager, stdout } = await createManager({ cols: 100, rows: 30 });

    manager.start();

    // 连续触发 3 次 resize
    (stdout as { columns: number }).columns = 110;
    (stdout as { rows: number }).rows = 35;
    stdout.emit("resize");

    (stdout as { columns: number }).columns = 120;
    (stdout as { rows: number }).rows = 40;
    stdout.emit("resize");

    (stdout as { columns: number }).columns = 130;
    (stdout as { rows: number }).rows = 45;
    stdout.emit("resize");

    // 防抖窗口内不应调用 resize
    expect(mockPty.resize).not.toHaveBeenCalled();

    // 等待防抖时间
    vi.advanceTimersByTime(50);

    // 只调用一次，使用最终尺寸
    expect(mockPty.resize).toHaveBeenCalledTimes(1);
    expect(mockPty.resize).toHaveBeenCalledWith(130, 45);

    vi.useRealTimers();
  });

  it("calls onSessionExit with child exit code instead of process.exit", async () => {
    const onSessionExit = vi.fn();
    const { manager } = await createManager({ onSessionExit });

    manager.start();
    expect(onExitCallback).not.toBeNull();
    onExitCallback!({ exitCode: 42, signal: 0 });

    expect(onSessionExit).toHaveBeenCalledWith(42);
  });

  it("calls onSessionExit with 128+signal for signal-based exit", async () => {
    const onSessionExit = vi.fn();
    const { manager } = await createManager({ onSessionExit });

    manager.start();
    expect(onExitCallback).not.toBeNull();
    onExitCallback!({ exitCode: 0, signal: 2 });

    expect(onSessionExit).toHaveBeenCalledWith(130);
  });

  it("cleanup kills child, restores raw mode, and calls onSessionExit", async () => {
    const onSessionExit = vi.fn();
    const { manager, stdin } = await createManager({
      isTTY: true,
      onSessionExit,
    });

    manager.start();
    manager.cleanup(1);

    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(mockPty.kill).toHaveBeenCalled();
    expect(onSessionExit).toHaveBeenCalledWith(1);
  });

  it("does not crash if onSessionExit is not provided", async () => {
    const { manager } = await createManager();

    manager.start();
    expect(onExitCallback).not.toBeNull();

    // 不传 onSessionExit 时触发退出不应抛异常
    expect(() => onExitCallback!({ exitCode: 0, signal: 0 })).not.toThrow();
  });

  it("does not register global process event handlers", async () => {
    const sigTermBefore = process.listenerCount("SIGTERM");
    const sigHupBefore = process.listenerCount("SIGHUP");
    const uncaughtBefore = process.listenerCount("uncaughtException");
    const unhandledBefore = process.listenerCount("unhandledRejection");

    const { manager } = await createManager();
    manager.start();

    expect(process.listenerCount("SIGTERM")).toBe(sigTermBefore);
    expect(process.listenerCount("SIGHUP")).toBe(sigHupBefore);
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBefore);
    expect(process.listenerCount("unhandledRejection")).toBe(unhandledBefore);
  });

  it("handles non-TTY stdin without setRawMode", async () => {
    const { manager, stdin } = await createManager({ isTTY: false });

    manager.start();

    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(stdin.resume).toHaveBeenCalled();
  });
});
