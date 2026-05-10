import { connect, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { SOCK_PATH, STOPPED_PATH, SERVICE_LOG_PATH, PROFILE_NAME } from "../common/paths.js";
import { spawnScript } from "../common/env.js";
import { daemonRelayArgs } from "../common/daemon-env.js";
import { createIpcReader, type IpcMessage } from "../ipc/ipc-protocol.js";
import { terminalLogger as log } from "../common/logger.js";

// serve daemon 自动拉起的连接重试参数
const ENSURE_SERVICE_MAX_RETRIES = 20;
const ENSURE_SERVICE_INITIAL_DELAY_MS = 100;
const ENSURE_SERVICE_MAX_DELAY_MS = 2_000;

// 等待特定类型 IPC 消息的默认超时
const WAIT_FOR_MESSAGE_TIMEOUT_MS = 10_000;

// 单次 socket 连接尝试：连上 resolve socket，连不上 resolve null（不抛异常）。
export function tryConnect(sockPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    s.on("connect", () => resolve(s));
    s.on("error", () => resolve(null));
  });
}

// 接到 serve daemon 的 unix socket 上：先尝试连接已有进程，连不上则拉起一个新 daemon
// 子进程并轮询直到 socket 就绪。autoStart=false 用于命令式 status 查询，禁止 spawn。
export async function ensureService(autoStart = true): Promise<Socket> {
  const existing = await tryConnect(SOCK_PATH);
  if (existing) {
    log.info("Connected to existing service");
    return existing;
  }

  if (!autoStart) throw new Error("Service is not running");

  if (existsSync(STOPPED_PATH)) unlinkSync(STOPPED_PATH);

  log.info("Auto-starting serve daemon");
  const child = spawnScript(
    new URL("../serve", import.meta.url),
    ["--profile", PROFILE_NAME, ...daemonRelayArgs()],
    {
      env: { ...process.env },
      logger: log,
    },
  );

  // 监听 daemon 失败信号，让下面的 tryConnect 轮询能在 daemon 启动时就崩的场景下立刻抛诊断。
  // - 'exit'：进程启动成功后又退出（配置错误、端口占用、内部崩溃），带 code/signal。
  // - 'error'：spawn 本身失败（ENOENT 找不到 tsx/node 等），Node 文档说此时 'exit' may or may not 跟着 fire，
  //   所以显式监听补完备性。spawnScript 内部另装了一对只管日志的监听器，跟这里互不影响。
  let childFailed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: Error | null = null;
  child.once("exit", (code, signal) => {
    childFailed = true;
    exitCode = code;
    exitSignal = signal;
  });
  child.once("error", (err) => {
    childFailed = true;
    spawnError = err;
  });

  for (let i = 0; i < ENSURE_SERVICE_MAX_RETRIES; i++) {
    const delay = Math.min(ENSURE_SERVICE_INITIAL_DELAY_MS * (i + 1), ENSURE_SERVICE_MAX_DELAY_MS);
    await sleep(delay);

    if (childFailed) {
      log.error(
        { code: exitCode, signal: exitSignal, err: spawnError && String(spawnError) },
        "Serve daemon failed to start",
      );
      const detail = spawnError
        ? `spawn error=${String(spawnError)}`
        : `code=${exitCode}, signal=${exitSignal}`;
      throw new Error(
        `Serve daemon failed to start (${detail}). Check ${SERVICE_LOG_PATH} for details.`,
      );
    }

    const socket = await tryConnect(SOCK_PATH);
    if (socket) {
      log.info({ attempt: i + 1 }, "Connected to service after retry");
      return socket;
    }
  }

  log.error({ maxRetries: ENSURE_SERVICE_MAX_RETRIES }, "Failed to connect to service");
  throw new Error(
    `Failed to connect to dev-anywhere service after ${ENSURE_SERVICE_MAX_RETRIES} retries. Check ${SERVICE_LOG_PATH} for details.`,
  );
}

// 等待指定类型的 IPC 消息一次。`createIpcReader` 注册临时 listener，匹配后立即清理。
// 超时返回 reject；调用方需自己保证 socket 不会同时被另一个 listener 持有否则消息可能被吃掉。
export function waitForMessage<T extends IpcMessage["type"]>(
  socket: Socket,
  messageType: T,
): Promise<Extract<IpcMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    const dispose = createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === messageType) {
        if (timeout) clearTimeout(timeout);
        dispose();
        resolve(msg as Extract<IpcMessage, { type: T }>);
      }
    });
    timeout = setTimeout(() => {
      dispose();
      reject(new Error(`Timeout waiting for ${messageType}`));
    }, WAIT_FOR_MESSAGE_TIMEOUT_MS);
  });
}
