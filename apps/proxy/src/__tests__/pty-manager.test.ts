import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
let onExitCallback:
  | ((e: { exitCode: number; signal?: number }) => void)
  | null = null;

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
      onExit: vi.fn(
        (cb: (e: { exitCode: number; signal?: number }) => void) => {
          onExitCallback = cb;
          return { dispose: vi.fn() };
        },
      ),
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
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let originalListeners: {
    SIGTERM: NodeJS.SignalsListener[];
    SIGHUP: NodeJS.SignalsListener[];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onDataCallback = null;
    onExitCallback = null;

    // 保存并移除已有的信号处理器，防止测试间干扰
    originalListeners = {
      SIGTERM: process.listeners("SIGTERM") as NodeJS.SignalsListener[],
      SIGHUP: process.listeners("SIGHUP") as NodeJS.SignalsListener[],
    };

    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as () => never);
  });

  afterEach(() => {
    processExitSpy.mockRestore();

    // 清理本次测试注册的信号处理器
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGHUP");
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");

    // 恢复原有的信号处理器
    for (const listener of originalListeners.SIGTERM) {
      process.on("SIGTERM", listener);
    }
    for (const listener of originalListeners.SIGHUP) {
      process.on("SIGHUP", listener);
    }
  });

  async function createManager(
    overrides: {
      claudeArgs?: string[];
      tap?: (data: string) => void;
      isTTY?: boolean;
      cols?: number;
      rows?: number;
    } = {},
  ) {
    const { PtyManager } = await import("../pty-manager.js");
    const pty = await import("node-pty");

    const stdin = createMockStdin(overrides.isTTY ?? true);
    const stdout = createMockStdout(
      overrides.cols ?? 120,
      overrides.rows ?? 40,
    );
    const tap = overrides.tap ?? vi.fn();

    const manager = new PtyManager({
      claudeArgs: overrides.claudeArgs ?? [],
      tap,
      stdin,
      stdout,
    });

    return { manager, stdin, stdout, tap, pty };
  }

  it("spawns claude with correct args and terminal dimensions", async () => {
    const { manager, pty } = await createManager({
      claudeArgs: ["--help"],
      cols: 120,
      rows: 40,
    });

    manager.start();

    expect(pty.spawn).toHaveBeenCalledWith(
      "claude",
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

  it("propagates child exit code", async () => {
    const { manager } = await createManager();

    manager.start();
    expect(onExitCallback).not.toBeNull();
    onExitCallback!({ exitCode: 42, signal: 0 });

    expect(processExitSpy).toHaveBeenCalledWith(42);
  });

  it("computes 128+signal for signal-based exit", async () => {
    const { manager } = await createManager();

    manager.start();
    expect(onExitCallback).not.toBeNull();
    onExitCallback!({ exitCode: 0, signal: 2 });

    expect(processExitSpy).toHaveBeenCalledWith(130);
  });

  it("cleanup kills child and restores raw mode", async () => {
    const { manager, stdin } = await createManager({ isTTY: true });

    manager.start();
    manager.cleanup(1);

    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(mockPty.kill).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("handles non-TTY stdin without setRawMode", async () => {
    const { manager, stdin } = await createManager({ isTTY: false });

    manager.start();

    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(stdin.resume).toHaveBeenCalled();
  });
});
