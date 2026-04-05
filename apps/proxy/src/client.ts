import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DataTap } from "./tap.js";
import { PtyManager } from "./pty-manager.js";
import {
  createIpcReader,
  serializeIpc,
  type IpcMessage,
} from "./ipc-protocol.js";

const CC_DIR = `${process.env.HOME}/.cc-anywhere`;
const SOCK_PATH = `${CC_DIR}/cc-anywhere.sock`;
const STOPPED_PATH = `${CC_DIR}/stopped`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function tryConnect(sockPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    s.on("connect", () => resolve(s));
    s.on("error", () => resolve(null));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// autoStart 为 true 时允许自动拉起服务，为 false 时只尝试连接
async function ensureService(autoStart = true): Promise<Socket> {
  const existing = await tryConnect(SOCK_PATH);
  if (existing) return existing;

  if (!autoStart) throw new Error("Service is not running");

  // 用户主动启动时清除 stopped 标记
  if (existsSync(STOPPED_PATH)) unlinkSync(STOPPED_PATH);

  // 启动 service 子进程，detached + unref 使其独立运行
  const servePath = join(__dirname, "serve.js");
  const child = spawn(process.execPath, [servePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // 轮询等待 service 就绪，指数退避上限 2s
  const maxRetries = 20;
  for (let i = 0; i < maxRetries; i++) {
    const delay = Math.min(100 * (i + 1), 2000);
    await sleep(delay);
    const socket = await tryConnect(SOCK_PATH);
    if (socket) return socket;
  }

  throw new Error(
    `Failed to connect to cc-anywhere service after ${maxRetries} retries. Check ${CC_DIR}/service.log for details.`,
  );
}

// 等待特定类型的 IPC 响应
function waitForMessage(
  socket: Socket,
  messageType: string,
): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${messageType}`));
    }, 10000);

    createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === messageType) {
        clearTimeout(timeout);
        resolve(msg);
      }
    });
  });
}

export async function startClient(claudeArgs: string[]): Promise<void> {
  let socket = await ensureService();
  let sessionId: string | null = null;
  let ptyManager: PtyManager | null = null;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let reconnecting = false;

  function setupHeartbeat(): void {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (socket.writable && sessionId) {
        socket.write(serializeIpc({ type: "heartbeat", sessionId }));
      }
    }, 10_000);
  }

  function setupSocketHandlers(): void {
    createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === "pty_input" && msg.sessionId === sessionId) {
        ptyManager?.write(msg.data);
      }
    });

    socket.on("close", () => {
      if (!reconnecting) {
        reconnecting = true;
        reconnectToServe();
      }
    });

    socket.on("error", () => {
      // close 事件会跟着触发，在那里处理重连
    });
  }

  async function reconnectToServe(): Promise<void> {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    const maxRetries = 60;
    for (let i = 0; i < maxRetries; i++) {
      await sleep(Math.min(1000 * (i + 1), 5000));
      try {
        // stopped 标记存在时只尝试连接，不自动拉起服务
        const stopped = existsSync(STOPPED_PATH);
        const newSocket = stopped
          ? await tryConnect(SOCK_PATH)
          : await ensureService();
        if (!newSocket) continue;
        socket = newSocket;
        reconnecting = false;

        setupSocketHandlers();

        // 用原有 sessionId 重新注册，保持会话连续性
        if (sessionId) {
          socket.write(
            serializeIpc({ type: "session_create_request", mode: "pty", sessionId }),
          );
          const resp = await waitForMessage(socket, "session_create_response");
          if (resp.type === "session_create_response" && !resp.error) {
            sessionId = resp.sessionId;
            socket.write(serializeIpc({ type: "pty_register", sessionId }));
          }
        }

        setupHeartbeat();
        return;
      } catch {
        // 继续重试
      }
    }
    // 重连失败不影响本地终端使用
    reconnecting = false;
  }

  // 请求创建 PTY 会话
  const responsePromise = waitForMessage(socket, "session_create_response");
  socket.write(
    serializeIpc({ type: "session_create_request", mode: "pty" }),
  );

  const response = await responsePromise;
  if (response.type !== "session_create_response") {
    throw new Error("Unexpected response type");
  }
  if (response.error) {
    throw new Error(`Failed to create session: ${response.error}`);
  }
  sessionId = response.sessionId;

  // PTY 输出通过 IPC 转发给 service
  const tap: DataTap = (data: string) => {
    if (socket.writable && sessionId) {
      socket.write(
        serializeIpc({ type: "pty_output", sessionId, data }),
      );
    }
  };

  setupSocketHandlers();

  ptyManager = new PtyManager({
    claudeArgs,
    tap,
    stdin: process.stdin,
    stdout: process.stdout,
    onSessionExit: (code: number) => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (socket.writable && sessionId) {
        socket.write(
          serializeIpc({ type: "pty_deregister", sessionId }),
        );
      }
      socket.end();
      process.exit(code);
    },
  });
  ptyManager.start();

  // 注册 PTY 会话
  socket.write(serializeIpc({ type: "pty_register", sessionId }));

  setupHeartbeat();

  // SIGTERM 触发优雅退出，SIGINT 让 PTY 子进程处理
  process.on("SIGTERM", () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (socket.writable && sessionId) {
      socket.write(serializeIpc({ type: "pty_deregister", sessionId }));
    }
    ptyManager?.cleanup(143);
  });
}
