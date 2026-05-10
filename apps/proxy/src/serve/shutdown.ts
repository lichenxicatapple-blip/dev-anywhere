import { unlinkSync } from "node:fs";
import { flushLogger, type Logger } from "@dev-anywhere/shared/logger";

// 收尾步骤里依赖的所有外部资源都通过 deps 注入；shutdown 函数本身只负责正确顺序与
// 单次执行守卫，便于以纯单元测试的方式覆盖双信号场景而不必拉起整个 service。
export interface ServeShutdownDeps {
  logger: Logger;
  sessionManagerStopReaper: () => void;
  relayRouterDestroy: () => void;
  hookServerClose: () => Promise<void>;
  relayConnectionClose: () => void;
  workerRegistryDestroyAll: () => void;
  hostedPtyRegistryDestroyAll: () => void;
  ipcServerClose: () => void;
  sockPath: string;
  pidPath: string;
  exit?: (code: number) => void;
}

// 双重 SIGTERM / SIGTERM+SIGINT 并发触发时，第二次直接返回。
// 真实场景：systemd TimeoutStopSec 到期再发一次 SIGTERM；用户连按两次 Ctrl+C 同样会双触发。
// 没有守卫时，第二路 process.exit(0) 可能在第一路 await flushLogger 完成前先返回，截断日志。
export function createServeShutdown(deps: ServeShutdownDeps): () => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;
  return async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info("Shutting down service");
    deps.sessionManagerStopReaper();
    // 先 destroy router：清掉 pending session-create retry timer，并 cleanupPendingJsonSession
    // 把已 spawn 但还未 connect 的 worker 子进程收掉，否则进入 destroyAll 时这批子进程
    // 会在 timer 命中后失去 parent 引用变孤儿（只有 sock destroy，没人发 SIGTERM 给 worker）。
    deps.relayRouterDestroy();
    await deps.hookServerClose();
    deps.relayConnectionClose();
    deps.workerRegistryDestroyAll();
    deps.hostedPtyRegistryDestroyAll();
    deps.ipcServerClose();
    try {
      unlinkSync(deps.sockPath);
    } catch {
      // 关闭时 socket 文件可能已被删除
    }
    try {
      unlinkSync(deps.pidPath);
    } catch {
      // 关闭时 PID 文件可能已被删除
    }
    await flushLogger(deps.logger);
    exit(0);
  };
}
