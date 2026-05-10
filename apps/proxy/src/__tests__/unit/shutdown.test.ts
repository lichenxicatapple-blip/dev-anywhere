import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServeShutdown, type ServeShutdownDeps } from "../../serve/shutdown.js";

// 双 SIGTERM 并发：第一路 await hookServerClose 期间第二路调进来，断言关闭步骤只跑一次，
// exit(0) 也只发一次——防止第二路 process.exit 抢先截断第一路 await flushLogger 的日志写入。
describe("createServeShutdown reentry guard", () => {
  let tmpDir: string;
  let sockPath: string;
  let pidPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "shutdown-test-"));
    sockPath = join(tmpDir, "service.sock");
    pidPath = join(tmpDir, "service.pid");
    writeFileSync(sockPath, "");
    writeFileSync(pidPath, "");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildDeps(overrides: Partial<ServeShutdownDeps> = {}): {
    deps: ServeShutdownDeps;
    spies: {
      stopReaper: ReturnType<typeof vi.fn>;
      relayRouterDestroy: ReturnType<typeof vi.fn>;
      hookServerClose: ReturnType<typeof vi.fn>;
      relayConnectionClose: ReturnType<typeof vi.fn>;
      workerRegistryDestroyAll: ReturnType<typeof vi.fn>;
      hostedPtyRegistryDestroyAll: ReturnType<typeof vi.fn>;
      ipcServerClose: ReturnType<typeof vi.fn>;
      exit: ReturnType<typeof vi.fn>;
    };
    releaseHookClose: () => void;
  } {
    const stopReaper = vi.fn();
    const relayRouterDestroy = vi.fn();
    const relayConnectionClose = vi.fn();
    const workerRegistryDestroyAll = vi.fn();
    const hostedPtyRegistryDestroyAll = vi.fn();
    const ipcServerClose = vi.fn();
    const exit = vi.fn();
    let releaseHookClose: () => void = () => {};
    const hookServerClose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseHookClose = resolve;
        }),
    );
    const deps: ServeShutdownDeps = {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        flush: vi.fn(),
      } as unknown as ServeShutdownDeps["logger"],
      sessionManagerStopReaper: stopReaper,
      relayRouterDestroy,
      hookServerClose,
      relayConnectionClose,
      workerRegistryDestroyAll,
      hostedPtyRegistryDestroyAll,
      ipcServerClose,
      sockPath,
      pidPath,
      exit,
      ...overrides,
    };
    return {
      deps,
      spies: {
        stopReaper,
        relayRouterDestroy,
        hookServerClose,
        relayConnectionClose,
        workerRegistryDestroyAll,
        hostedPtyRegistryDestroyAll,
        ipcServerClose,
        exit,
      },
      releaseHookClose: () => releaseHookClose(),
    };
  }

  it("invokes each cleanup step exactly once when called twice concurrently", async () => {
    const { deps, spies, releaseHookClose } = buildDeps();
    const shutdown = createServeShutdown(deps);

    // 第一路触发并卡在 hookServerClose 的 pending promise 上
    const first = shutdown();
    expect(spies.stopReaper).toHaveBeenCalledTimes(1);
    expect(spies.hookServerClose).toHaveBeenCalledTimes(1);

    // 第二路在第一路 await 期间到达：守卫应让其立即返回，不再触碰任何资源
    const second = shutdown();

    // 释放 hookServerClose，让第一路把后续步骤跑完
    releaseHookClose();
    await Promise.all([first, second]);

    expect(spies.stopReaper).toHaveBeenCalledTimes(1);
    expect(spies.relayRouterDestroy).toHaveBeenCalledTimes(1);
    expect(spies.hookServerClose).toHaveBeenCalledTimes(1);
    expect(spies.relayConnectionClose).toHaveBeenCalledTimes(1);
    expect(spies.workerRegistryDestroyAll).toHaveBeenCalledTimes(1);
    expect(spies.hostedPtyRegistryDestroyAll).toHaveBeenCalledTimes(1);
    expect(spies.ipcServerClose).toHaveBeenCalledTimes(1);
    expect(spies.exit).toHaveBeenCalledTimes(1);
    expect(spies.exit).toHaveBeenCalledWith(0);
  });

  it("removes sock and pid files when they exist", async () => {
    const { deps, releaseHookClose } = buildDeps();
    const shutdown = createServeShutdown(deps);
    const first = shutdown();
    releaseHookClose();
    await first;
    expect(existsSync(sockPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
  });

  it("does not throw when sock/pid files are already missing", async () => {
    rmSync(sockPath);
    rmSync(pidPath);
    const { deps, spies, releaseHookClose } = buildDeps();
    const shutdown = createServeShutdown(deps);
    const first = shutdown();
    releaseHookClose();
    await expect(first).resolves.toBeUndefined();
    expect(spies.exit).toHaveBeenCalledWith(0);
  });
});
